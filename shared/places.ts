/**
 * Coastal reference points. They are used for map labels, for classifying the wind regime and
 * for naming the strongest gust. Coordinates are approximate town or harbour positions.
 * `label` marks the ones drawn on the map.
 */
export interface Place {
  name: string;
  lon: number;
  lat: number;
  label?: boolean;
}

export const PLACES: Place[] = [
  { name: 'Trieste', lon: 13.77, lat: 45.65 },
  { name: 'Poreč', lon: 13.59, lat: 45.23 },
  { name: 'Rovinj', lon: 13.64, lat: 45.08 },
  { name: 'Pula', lon: 13.85, lat: 44.87, label: true },
  { name: 'Rijeka', lon: 14.44, lat: 45.33, label: true },
  { name: 'Bakar', lon: 14.53, lat: 45.3 },
  { name: 'Crikvenica', lon: 14.69, lat: 45.17 },
  { name: 'Krk', lon: 14.57, lat: 45.03 },
  { name: 'Senj', lon: 14.9, lat: 44.99, label: true },
  { name: 'Mali Lošinj', lon: 14.47, lat: 44.53, label: true },
  { name: 'Rab', lon: 14.76, lat: 44.76 },
  { name: 'Jablanac', lon: 14.9, lat: 44.71 },
  { name: 'Karlobag', lon: 15.07, lat: 44.53 },
  { name: 'Pag', lon: 15.06, lat: 44.45 },
  { name: 'Zadar', lon: 15.23, lat: 44.12, label: true },
  { name: 'Biograd', lon: 15.44, lat: 43.94 },
  { name: 'Šibenik', lon: 15.89, lat: 43.73, label: true },
  { name: 'Primošten', lon: 15.92, lat: 43.59 },
  { name: 'Trogir', lon: 16.25, lat: 43.52 },
  { name: 'Split', lon: 16.44, lat: 43.51, label: true },
  { name: 'Omiš', lon: 16.69, lat: 43.44 },
  { name: 'Makarska', lon: 17.02, lat: 43.3, label: true },
  { name: 'Hvar', lon: 16.44, lat: 43.17 },
  { name: 'Vis', lon: 16.18, lat: 43.06, label: true },
  { name: 'Korčula', lon: 17.13, lat: 42.96 },
  { name: 'Lastovo', lon: 16.9, lat: 42.77 },
  { name: 'Ploče', lon: 17.43, lat: 43.05 },
  { name: 'Dubrovnik', lon: 18.09, lat: 42.65, label: true },
  { name: 'Cavtat', lon: 18.22, lat: 42.58 },
];

/** Croatian coastal sample points (excludes Trieste) used for regime classification. */
export const REGIME_POINTS = PLACES.filter((p) => p.name !== 'Trieste');

export function nearestPlace(lon: number, lat: number, places: Place[] = PLACES): Place {
  let best = places[0];
  let bestD = Infinity;
  for (const p of places) {
    const d = (p.lon - lon) ** 2 * 0.52 + (p.lat - lat) ** 2; // cos²(44°) ≈ 0.52
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
