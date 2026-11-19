/** Regular lon/lat grid. Node (i, j) sits at (lon0 + i*dlon, lat0 + j*dlat); row j=0 is the south edge. */
export interface GridSpec {
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
  nx: number;
  ny: number;
}

/** Rendering domain. Slightly larger than the core region so the field fills wide screens. */
export const DOMAIN = { lonMin: 12, lonMax: 21, latMin: 41.5, latMax: 46.5 } as const;

/** Core region sampled densely from the model (the brief's 42–46°N, 13–19.5°E). */
export const CORE = { lonMin: 13, lonMax: 19.5, latMin: 42, latMax: 46 } as const;

/** Model grid: 0.25° everywhere in the domain; nodes outside CORE are only fetched on the 0.5° sub-lattice. */
export const MODEL_GRID: GridSpec = { lon0: 12, lat0: 41.5, dlon: 0.25, dlat: 0.25, nx: 37, ny: 21 };

/** Output grid served to clients: 0.1° (~8 × 11 km). */
export const OUT_GRID: GridSpec = { lon0: 12, lat0: 41.5, dlon: 0.1, dlat: 0.1, nx: 91, ny: 51 };

export const nodeLon = (g: GridSpec, i: number) => +(g.lon0 + i * g.dlon).toFixed(6);
export const nodeLat = (g: GridSpec, j: number) => +(g.lat0 + j * g.dlat).toFixed(6);
export const cellCount = (g: GridSpec) => g.nx * g.ny;

const inCore = (lon: number, lat: number) =>
  lon >= CORE.lonMin - 1e-9 && lon <= CORE.lonMax + 1e-9 && lat >= CORE.latMin - 1e-9 && lat <= CORE.latMax + 1e-9;

/**
 * Which MODEL_GRID nodes are fetched from the API. Core nodes at full 0.25°, everything else on
 * the 0.5° lattice (even i, even j). Keeps a fetch at ~540 locations, below Open-Meteo's
 * 600-calls-per-minute fair-use limit, while the coast keeps full resolution.
 */
export function modelSampleMask(g: GridSpec = MODEL_GRID): Uint8Array {
  const mask = new Uint8Array(cellCount(g));
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const sampled = inCore(nodeLon(g, i), nodeLat(g, j)) || (i % 2 === 0 && j % 2 === 0);
      mask[j * g.nx + i] = sampled ? 1 : 0;
    }
  }
  return mask;
}

/** Great-circle-ish distance in km (equirectangular; accurate to <0.5% at this scale). */
export function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return 6371 * Math.hypot(x, y);
}
