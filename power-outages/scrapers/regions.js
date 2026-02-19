// ISO 3166-2:NZ Region Codes
// https://en.wikipedia.org/wiki/Regions_of_New_Zealand

export const REGIONS = {
  'Northland': 'NZ-NTL',
  'Auckland': 'NZ-AUK',
  'Waikato': 'NZ-WKO',
  'Bay of Plenty': 'NZ-BOP',
  'Gisborne': 'NZ-GIS',
  'Hawke\'s Bay': 'NZ-HKB',
  'Taranaki': 'NZ-TKI',
  'Manawatu-Whanganui': 'NZ-MWT',
  'Wellington': 'NZ-WGN',
  'Tasman': 'NZ-TAS',
  'Nelson': 'NZ-NSN',
  'Marlborough': 'NZ-MBH',
  'West Coast': 'NZ-WTC',
  'Canterbury': 'NZ-CAN',
  'Otago': 'NZ-OTA',
  'Southland': 'NZ-STL'
};

export function getRegionCode(regionName) {
  return REGIONS[regionName] || null;
}

export function getRegionName(code) {
  return Object.keys(REGIONS).find(name => REGIONS[name] === code) || null;
}
