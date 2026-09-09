// WITS transmission-outage analysis (shared by the CLI and the server).
// -----------------------------------------------------------------------------
// Pure functions that take a WITS outages payload + a substation-location map
// and return a ranked shortlist of plausibly-impacting current / imminent /
// short-notice / extended outages. See emi-transmission-outages.js for the CLI
// wrapper and the full rationale behind each heuristic.
// -----------------------------------------------------------------------------

// Entries in effect longer than this are treated as long-term background
// (derations / decommissioned assets), not active fieldwork.
export const BACKGROUND_DAYS = 60;
// Default look-ahead window for "imminent" scheduled outages.
export const DEFAULT_IMMINENT_HOURS = 48;
// An outage that first appears within this many hours of its own start time was
// scheduled at short notice — the profile of an unplanned / emergency outage.
export const SHORT_NOTICE_HOURS = 6;
// An end-time pushed out by at least this many hours beyond the previously
// published end counts as an "extension" (extended past planned end).
export const EXTENSION_HOURS = 3;

export const COMPONENT_TYPES = {
  LN: 'line/circuit',
  XF: 'transformer',
  CB: 'circuit breaker',
  CP: 'capacitor',
  UN: 'unit',
  DIS: 'disconnector',
};

// Substation prefixes that are generation connection sites rather than demand
// exit points — used only to annotate.
export const KNOWN_GENERATION_SUBS = new Set(['KIW']); // Kaiwera Downs (wind)

export function parseNz(s) {
  if (!s) return null;
  // "YYYY-MM-DD HH:MM:SS" NZ local time; compared against run_time (same clock).
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, se);
}

export function substationPrefix(componentId) {
  const m = /^([A-Z]+)/.exec(componentId || '');
  return m ? m[1] : (componentId || '').slice(0, 3);
}

export function classifyTiming(item, now, imminentHours) {
  const start = parseNz(item.start_time);
  const end = parseNz(item.end_time);
  if (start && start <= now && (!end || end >= now)) return 'current';
  if (start && start > now) {
    const hoursAway = (start - now) / 36e5;
    return hoursAway <= imminentHours ? 'imminent' : 'future';
  }
  if (end && end < now) return 'ended';
  return 'unknown';
}

/**
 * @param {{content?:{items?:object[]}}} payload WITS outages feed payload
 * @param {{imminentHours?:number, includeAll?:boolean}} opts
 * @param {Map<string,object>} locations substation -> {description,island,latitude,longitude}
 * @returns {{stats:object, events:object[]}}
 */
export function analyze(payload, { imminentHours = DEFAULT_IMMINENT_HOURS, includeAll = false } = {}, locations = new Map()) {
  const items = (payload.content && payload.content.items) || [];
  const runTime = items.length ? parseNz(items[0].run_time) : new Date();
  const now = runTime || new Date();

  const enriched = items
    .filter((i) => !i.cancelled)
    .map((i) => {
      const start = parseNz(i.start_time);
      const timing = classifyTiming(i, now, imminentHours);
      const inEffectDays = start && start <= now ? (now - start) / 864e5 : 0;
      const sub = substationPrefix(i.component_id);

      const end = parseNz(i.end_time);
      const lastEnd = parseNz(i.last_end_time);
      const extendedHours = end && lastEnd && end > lastEnd ? (end - lastEnd) / 36e5 : 0;
      const isExtended =
        (timing === 'current' || timing === 'imminent') && extendedHours >= EXTENSION_HOURS;

      const firstSeen = parseNz(i.last_run_time) || now;
      const leadHours = start ? (start - firstSeen) / 36e5 : null;
      const isShortNotice =
        !i.last_run_time && start != null && Math.abs(leadHours) <= SHORT_NOTICE_HOURS;

      return {
        outageId: i.outage_id,
        componentId: i.component_id,
        outageBlock: i.outage_block,
        componentType: i.component_type,
        componentTypeLabel: COMPONENT_TYPES[i.component_type] || i.component_type,
        status: i.status,
        startTime: i.start_time,
        endTime: i.end_time,
        substation: sub,
        timing,
        inEffectDays,
        extendedHours,
        isExtended,
        isShortNotice,
        isBackground:
          timing === 'current' &&
          inEffectDays > BACKGROUND_DAYS &&
          !isExtended &&
          !isShortNotice,
        isGenerationSite: KNOWN_GENERATION_SUBS.has(sub),
      };
    });

  const shortlistItems = enriched.filter((e) => {
    if (includeAll) return true;
    if (e.isShortNotice || e.isExtended) return true;
    if (e.isBackground) return false;
    return e.timing === 'current' || e.timing === 'imminent';
  });

  const groups = new Map();
  for (const e of shortlistItems) {
    const key = `${e.substation}\u0000${e.outageBlock}`;
    if (!groups.has(key)) {
      const loc = locations.get(e.substation) || null;
      groups.set(key, {
        substation: e.substation,
        outageBlock: e.outageBlock,
        description: loc ? loc.description : null,
        island: loc ? loc.island : null,
        location: loc ? { latitude: loc.latitude, longitude: loc.longitude } : null,
        mapped: !!loc,
        isGenerationSite: e.isGenerationSite,
        components: [],
        timings: new Set(),
        shortNotice: false,
        extended: false,
        maxExtendedHours: 0,
        earliestStart: e.startTime,
        latestEnd: e.endTime,
      });
    }
    const g = groups.get(key);
    g.components.push({
      componentId: e.componentId,
      type: e.componentType,
      typeLabel: e.componentTypeLabel,
      status: e.status,
      start: e.startTime,
      end: e.endTime,
      timing: e.timing,
      shortNotice: e.isShortNotice,
      extendedHours: Math.round(e.extendedHours),
    });
    g.timings.add(e.timing);
    if (e.isShortNotice) g.shortNotice = true;
    if (e.isExtended) g.extended = true;
    if (e.extendedHours > g.maxExtendedHours) g.maxExtendedHours = e.extendedHours;
    if (e.startTime && e.startTime < g.earliestStart) g.earliestStart = e.startTime;
    if (e.endTime && e.endTime > g.latestEnd) g.latestEnd = e.endTime;
  }

  const scored = [...groups.values()].map((g) => {
    const componentCount = g.components.length;
    const coordinated = componentCount > 1;
    const isCurrent = g.timings.has('current');
    const isImminent = g.timings.has('imminent');
    let score = 0;
    if (isCurrent) score += 100;
    else if (isImminent) score += 50;
    score += Math.min(componentCount, 6) * 10;
    if (coordinated && isCurrent) score += 25;
    if (g.shortNotice) score += 60;
    if (g.extended) score += 20;
    if (!g.mapped) score -= 5;

    let kind = 'planned';
    if (g.shortNotice) kind = 'unplanned?';
    else if (g.extended) kind = 'extended';

    return {
      ...g,
      timings: [...g.timings],
      componentCount,
      coordinated,
      kind,
      phase: isCurrent ? 'current' : isImminent ? 'imminent' : g.timings[0] || 'future',
      score,
    };
  });
  scored.sort((a, b) => b.score - a.score || b.componentCount - a.componentCount);

  const stats = {
    runTime: items.length ? items[0].run_time : null,
    totalItems: items.length,
    active: enriched.filter((e) => !e.cancelled).length,
    current: enriched.filter((e) => e.timing === 'current').length,
    imminent: enriched.filter((e) => e.timing === 'imminent').length,
    future: enriched.filter((e) => e.timing === 'future').length,
    background: enriched.filter((e) => e.isBackground).length,
    shortNotice: enriched.filter((e) => e.isShortNotice).length,
    extended: enriched.filter((e) => e.isExtended).length,
    shortlistItems: shortlistItems.length,
    eventGroups: scored.length,
    unmappedSubstations: [...new Set(scored.filter((g) => !g.mapped).map((g) => g.substation))],
  };

  return { stats, events: scored };
}
