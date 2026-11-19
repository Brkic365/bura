/**
 * Open-Meteo forecast API (https://open-meteo.com): free for non-commercial use, data CC BY 4.0.
 * Fair use for the free tier: < 10,000 calls/day, 5,000/hour, 600/minute. Each location in a
 * multi-location request counts as one call.
 *
 * One fetch = 542 locations (0.25° core + 0.5° ring, see modelSampleMask). It runs at most every
 * 3 hours, about 4,300 calls/day, and returns 10 m wind speed, direction and gusts from
 * 24 h ago to +72 h ("best_match" picks the highest-resolution model available for each point;
 * for the Adriatic that is mostly ICON-EU/ICON-D2).
 */
import { MODEL_GRID, cellCount, modelSampleMask, nodeLat, nodeLon } from '../shared/grid.js';
import { fillFromLattice } from '../shared/interp.js';
import type { ModelSeries } from '../shared/types.js';
import { toUV } from '../shared/wind.js';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const CHUNK = 180;

interface OMLocation {
  latitude: number;
  longitude: number;
  hourly?: {
    time: number[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
    wind_gusts_10m: (number | null)[];
  };
}

export function sampleNodes(): { k: number; lon: number; lat: number }[] {
  const mask = modelSampleMask(MODEL_GRID);
  const nodes: { k: number; lon: number; lat: number }[] = [];
  for (let j = 0; j < MODEL_GRID.ny; j++)
    for (let i = 0; i < MODEL_GRID.nx; i++) {
      const k = j * MODEL_GRID.nx + i;
      if (mask[k]) nodes.push({ k, lon: nodeLon(MODEL_GRID, i), lat: nodeLat(MODEL_GRID, j) });
    }
  return nodes;
}

export function buildUrl(nodes: { lon: number; lat: number }[]): string {
  const p = new URLSearchParams({
    latitude: nodes.map((n) => n.lat.toFixed(2)).join(','),
    longitude: nodes.map((n) => n.lon.toFixed(2)).join(','),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'ms',
    timeformat: 'unixtime',
    timezone: 'GMT',
    past_days: '1',
    forecast_days: '3',
    cell_selection: 'nearest',
  });
  return `${OPEN_METEO_URL}?${p}`;
}

/** Assemble Open-Meteo multi-location responses (same order as `nodes`) into a gridded series. */
export function assembleSeries(nodes: { k: number }[], locations: OMLocation[], fetchedAt: number): ModelSeries {
  if (locations.length !== nodes.length) throw new Error(`Open-Meteo: expected ${nodes.length} locations, got ${locations.length}`);
  const times = locations[0]?.hourly?.time;
  if (!times?.length) throw new Error('Open-Meteo: no hourly data');
  const n = cellCount(MODEL_GRID);
  const mask = modelSampleMask(MODEL_GRID);
  const series: ModelSeries = { fetchedAt, source: 'open-meteo:best_match', grid: MODEL_GRID, times: [...times], u: [], v: [], gust: [] };
  for (let ti = 0; ti < times.length; ti++) {
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const g = new Float32Array(n);
    for (let s = 0; s < nodes.length; s++) {
      const h = locations[s].hourly!;
      const spd = h.wind_speed_10m[ti] ?? 0;
      const dir = h.wind_direction_10m[ti] ?? 0;
      const [uu, vv] = toUV(dir, spd);
      u[nodes[s].k] = uu;
      v[nodes[s].k] = vv;
      g[nodes[s].k] = h.wind_gusts_10m[ti] ?? spd;
    }
    series.u.push(fillFromLattice(MODEL_GRID, u, mask));
    series.v.push(fillFromLattice(MODEL_GRID, v, mask));
    series.gust.push(fillFromLattice(MODEL_GRID, g, mask));
  }
  return series;
}

export async function fetchOpenMeteo(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<ModelSeries> {
  const nodes = sampleNodes();
  const locations: OMLocation[] = [];
  for (let i = 0; i < nodes.length; i += CHUNK) {
    const chunk = nodes.slice(i, i + CHUNK);
    const res = await fetchImpl(buildUrl(chunk));
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    locations.push(...(Array.isArray(json) ? json : [json]));
  }
  return assembleSeries(nodes, locations, Math.floor(now / 1000));
}
