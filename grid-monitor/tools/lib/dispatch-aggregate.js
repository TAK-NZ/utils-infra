// Site-level aggregation of EMI real-time-dispatch records.
// -----------------------------------------------------------------------------
// A single substation is represented by several dispatch POC codes (buses).
// Load/generation is often reported on one bus while sibling buses read zero
// (e.g. Benmore: one bus at 544 MW, four at 0). To reason about whether a SITE
// is doing anything, we must aggregate all its POCs.
//
// This module groups classified dispatch records by substation, sums load and
// generation, and classifies each site by OBSERVED behavior. It also separates
// the two meaningful "inactive" cases from the noise:
//   * a site with a real NSP role (consumer/generation/both) reading zero is an
//     anomaly candidate;
//   * a site that is only inert grid buses (no NSP demand/gen record) reading
//     zero is expected and excluded.
// -----------------------------------------------------------------------------

const ZERO_MW = 0.05;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * Join raw dispatch records to NSP roles via a classifier.
 * @param {Array<object>} records raw EMI dispatch records
 * @param {{classify: (code:string)=>object}} classifier from loadPocClassifier()
 * @returns {Array<object>} enriched records used by aggregateSites()
 */
export function classifyDispatch(records, classifier) {
  return records.map((r) => {
    const c = classifier.classify(r.PointOfConnectionCode);
    const load = num(r.SPDLoadMegawatt);
    const gen = num(r.SPDGenerationMegawatt);
    return {
      poc: r.PointOfConnectionCode,
      matched: c.matched,
      substation: c.substation,
      role: c.role,
      description: c.description,
      island: c.island,
      load,
      generation: gen,
      price: num(r.DollarsPerMegawattHour),
      active: Math.abs(load) > ZERO_MW || gen > ZERO_MW,
    };
  });
}

/**
 * @param {Array<object>} classified records from classifyDispatch (each has
 *   substation, role, matched, load, generation, price, description, island)
 * @returns {{sites: object[], summary: object}}
 */
export function aggregateSites(classified) {
  const bySub = new Map();
  for (const r of classified) {
    if (!bySub.has(r.substation)) {
      bySub.set(r.substation, {
        substation: r.substation,
        description: null,
        island: null,
        pocs: [],
        totalLoad: 0,
        totalGeneration: 0,
        activePocs: 0,
        nspRoles: new Set(),
        hasRealRole: false,
        prices: [],
      });
    }
    const s = bySub.get(r.substation);
    s.pocs.push(r);
    s.totalLoad += r.load;
    s.totalGeneration += r.generation;
    if (r.active) s.activePocs++;
    if (r.description && !s.description) s.description = r.description;
    if (r.island && !s.island) s.island = r.island;
    if (r.matched) {
      s.hasRealRole = true;
      s.nspRoles.add(r.role);
    }
    if (Number.isFinite(r.price)) s.prices.push(r.price);
  }

  const sites = [...bySub.values()].map((s) => {
    const gen = s.totalGeneration;
    const load = s.totalLoad;
    const generating = gen > ZERO_MW;
    const drawing = Math.abs(load) > ZERO_MW;

    // Observed behavior of the whole site.
    let behavior;
    if (generating && drawing) behavior = 'mixed';
    else if (generating) behavior = 'generation';
    else if (drawing) behavior = 'load';
    else behavior = 'inactive';

    // Static NSP capability. NOTE: the "both" flag means "physically capable of
    // import AND export", which describes almost every station/GXP bus. It is a
    // WEAK signal on its own — using it alone floods both cases with false
    // positives (e.g. a pure load GXP flagged generation-capable, or a 600 MW
    // hydro station flagged consumption-capable). We keep it only as a sanity
    // filter, not the primary role signal.
    const nspGenCapable = s.pocs.some((p) => p.matched && (p.role === 'generation' || p.role === 'both'));
    const nspLoadCapable = s.pocs.some((p) => p.matched && (p.role === 'consumer' || p.role === 'both'));
    // A bus flagged ONLY generation / ONLY consumer is a strong static signal.
    const nspPureGen = s.pocs.some((p) => p.matched && p.role === 'generation');
    const nspPureLoad = s.pocs.some((p) => p.matched && p.role === 'consumer');

    // Anomaly candidates require an OBSERVED role, not just static capability.
    // From a single snapshot we can only assert the silent-case when the site's
    // static role is unambiguous (a pure-generation or pure-consumer bus). The
    // ambiguous "both"-only sites cannot be classified from one snapshot — that
    // is exactly what the historical baseline (step 2b) is for.
    //
    //   Case A: a site with a pure-generation NSP bus that is producing nothing.
    //   Case B: a site with a pure-consumer NSP bus that is drawing nothing.
    const genSilent = nspPureGen && !generating && !drawing;
    const loadSilent = nspPureLoad && !drawing && !generating;

    // Kept for reference/JSON: capability flags.
    const canGenerate = nspGenCapable;
    const canConsume = nspLoadCapable;

    const avgPrice = s.prices.length
      ? s.prices.reduce((a, b) => a + b, 0) / s.prices.length
      : null;

    return {
      substation: s.substation,
      description: s.description,
      island: s.island,
      pocCount: s.pocs.length,
      activePocs: s.activePocs,
      totalLoad: Number(load.toFixed(3)),
      totalGeneration: Number(gen.toFixed(3)),
      behavior,
      nspRoles: [...s.nspRoles],
      hasRealRole: s.hasRealRole,
      canGenerate,
      canConsume,
      genSilent,
      loadSilent,
      avgPrice: avgPrice == null ? null : Number(avgPrice.toFixed(2)),
      pocs: s.pocs.map((p) => ({
        poc: p.poc, role: p.role, matched: p.matched,
        load: p.load, generation: p.generation, price: p.price,
      })),
    };
  });

  const summary = {
    totalSites: sites.length,
    generation: sites.filter((s) => s.behavior === 'generation').length,
    load: sites.filter((s) => s.behavior === 'load').length,
    mixed: sites.filter((s) => s.behavior === 'mixed').length,
    inactive: sites.filter((s) => s.behavior === 'inactive').length,
    inactiveWithRealRole: sites.filter((s) => s.behavior === 'inactive' && s.hasRealRole).length,
    genSilent: sites.filter((s) => s.genSilent).length,
    loadSilent: sites.filter((s) => s.loadSilent).length,
  };

  return { sites, summary };
}
