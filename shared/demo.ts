/**
 * Synthetic wind scenarios, used for offline development, the screenshots in the case study and
 * the `?demo=bura|jugo|maestral` URL. They are not forecasts. The shapes are hand-built to
 * look like each regime:
 *
 * - Bura: katabatic NE jets that leave the Dinaric gaps (Senj, Vrata, Karlobag, Klis, Biokovo…)
 *   and fan out downwind over the sea. Very gusty (gust factor ≈ 1.8).
 * - Jugo: broad SE flow along the Adriatic axis, strongest in the open southern Adriatic and
 *   weakening into the Kvarner bays. Steady (gust factor ≈ 1.3).
 * - Maestral: diurnal NW sea breeze, afternoon peak, near-calm nights with a weak land-breeze burin.
 */
import { type GridSpec, OUT_GRID, cellCount, nodeLat, nodeLon } from './grid.js';
import { type LandMask, isLandAt } from './landmask.js';
import { PLACES } from './places.js';
import type { Bundle, ObsSnapshot, Station } from './types.js';
import { compass, fromUV, parseDirection, toUV } from './wind.js';

export type DemoScenario = 'bura' | 'jugo' | 'maestral';
export const DEMO_SCENARIOS: DemoScenario[] = ['bura', 'jugo', 'maestral'];

const RAD = Math.PI / 180;
const KM_PER_DEG = 111.2;

interface Gap {
  lon: number;
  lat: number;
  amp: number;
  fromDeg: number;
  len: number;
}

const BURA_GAPS: Gap[] = [
  { lon: 13.77, lat: 45.66, amp: 13, fromDeg: 70, len: 45 }, // Trieste
  { lon: 14.55, lat: 45.31, amp: 13, fromDeg: 45, len: 45 }, // Vrata → Bakar
  { lon: 14.9, lat: 45.0, amp: 21, fromDeg: 55, len: 70 }, // Senj
  { lon: 14.92, lat: 44.75, amp: 13, fromDeg: 55, len: 45 }, // Jablanac → Rab
  { lon: 15.08, lat: 44.54, amp: 14, fromDeg: 50, len: 55 }, // Karlobag → Pag
  { lon: 15.46, lat: 44.29, amp: 11, fromDeg: 35, len: 40 }, // Paklenica / Velebit channel
  { lon: 15.9, lat: 43.75, amp: 8, fromDeg: 30, len: 40 }, // Šibenik
  { lon: 16.48, lat: 43.55, amp: 14, fromDeg: 25, len: 55 }, // Klis → Split
  { lon: 17.03, lat: 43.32, amp: 16, fromDeg: 40, len: 50 }, // Biokovo → Makarska
  { lon: 17.45, lat: 43.06, amp: 10, fromDeg: 45, len: 40 }, // Neretva
  { lon: 18.1, lat: 42.67, amp: 11, fromDeg: 30, len: 40 }, // Dubrovnik
];

/** Cheap smooth pseudo-noise in [-1, 1]: a few incommensurate plane waves. */
function noise(lon: number, lat: number, h: number, seed: number): number {
  const s = seed * 1.618;
  return (
    (Math.sin(lon * 2.1 + lat * 1.3 + h * 0.21 + s) +
      Math.sin(lon * -1.7 + lat * 2.9 + h * 0.13 + s * 2.3) * 0.7 +
      Math.sin(lon * 4.3 - lat * 3.7 + h * 0.37 + s * 3.1) * 0.4) /
    2.1
  );
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function bura(lon: number, lat: number, h: number, land: boolean): [number, number, number] {
  const env = 0.35 + 0.65 * Math.exp(-(((h - 6) / 22) ** 2));
  const base = (land ? 3.5 : 6.5) + noise(lon, lat, h, 1) * 1.2;
  let [u, v] = toUV(48 + noise(lon, lat, h, 2) * 8, base * env);
  const cosLat = Math.cos(lat * RAD);
  for (let k = 0; k < BURA_GAPS.length; k++) {
    const g = BURA_GAPS[k];
    const toward = (g.fromDeg + 180) * RAD;
    const ex = Math.sin(toward);
    const ey = Math.cos(toward);
    const dx = (lon - g.lon) * KM_PER_DEG * cosLat;
    const dy = (lat - g.lat) * KM_PER_DEG;
    const along = dx * ex + dy * ey;
    const across = -dx * ey + dy * ex;
    const width = 7 + 0.32 * Math.max(along, 0);
    const shape = sigmoid((along + 5) / 3) * Math.exp(-Math.max(along, 0) / g.len) * Math.exp(-((across / width) ** 2));
    if (shape < 1e-3) continue;
    const pulse = 1 + 0.18 * Math.sin(h * 0.9 + k * 1.7);
    const s = g.amp * env * pulse * shape * (land && along > 2 ? 0.6 : 1);
    u += s * ex;
    v += s * ey;
  }
  const spd = Math.hypot(u, v);
  return [u, v, spd * (land ? 1.55 : 1.8) + 1.5];
}

function jugo(lon: number, lat: number, h: number, land: boolean): [number, number, number] {
  const env = 0.4 + 0.6 * Math.exp(-(((h - 12) / 26) ** 2));
  const south = Math.min(1, Math.max(0, (45.6 - lat) / 3.6));
  // Distance from the Adriatic's NW–SE centre line: strongest mid-basin.
  const axis = (lat - 44.0) + (lon - 15.2) * 0.62;
  const mid = Math.exp(-((axis / 1.1) ** 2));
  let spd = (7 + 13 * south) * (0.7 + 0.3 * mid) * env;
  if (land) spd *= 0.4;
  spd *= 1 + 0.12 * noise(lon, lat, h, 3);
  const dir = 132 + noise(lon, lat, h, 4) * 10 - (1 - south) * 8;
  const [u, v] = toUV(dir, spd);
  return [u, v, spd * 1.3 + 1];
}

function maestral(lon: number, lat: number, h: number, land: boolean, localHour: number): [number, number, number] {
  const day = Math.max(0, Math.sin(((localHour - 9) / 12) * Math.PI)); // 0 before 9h and after 21h, peak 15h
  let spd = (1.2 + 6.8 * day) * (land ? 0.35 : 1) * (1 + 0.15 * noise(lon, lat, h, 5));
  let dir = 305 + noise(lon, lat, h, 6) * 12;
  if (day === 0) {
    dir = 40 + noise(lon, lat, h, 7) * 25; // night burin
    spd = (land ? 1.2 : 2.2) * (1 + 0.3 * noise(lon, lat, h, 8));
  }
  const [u, v] = toUV(dir, spd);
  return [u, v, spd * 1.35 + 0.8];
}

/** A synthetic bundle on the 0.1° grid for [now − 24 h, now + 48 h], with fake DHMZ-like station reports. */
export function makeDemoBundle(scenario: DemoScenario, nowS: number, mask: LandMask): Bundle {
  const g: GridSpec = OUT_GRID;
  const n = cellCount(g);
  const t0 = Math.floor(nowS / 3600) * 3600;
  const times: number[] = [];
  for (let hh = -24; hh <= 48; hh++) times.push(t0 + hh * 3600);
  const landAt = new Uint8Array(n);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) landAt[j * g.nx + i] = isLandAt(mask, nodeLon(g, i), nodeLat(g, j)) ? 1 : 0;

  const sample = (lon: number, lat: number, t: number, land: boolean) => {
    const h = (t - t0) / 3600;
    const localHour = (new Date(t * 1000).getUTCHours() + 1) % 24;
    return scenario === 'bura' ? bura(lon, lat, h, land) : scenario === 'jugo' ? jugo(lon, lat, h, land) : maestral(lon, lat, h, land, localHour);
  };

  const model = { fetchedAt: nowS, source: `demo:${scenario}`, grid: g, times, u: [] as Float32Array[], v: [] as Float32Array[], gust: [] as Float32Array[] };
  for (const t of times) {
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const gust = new Float32Array(n);
    for (let j = 0; j < g.ny; j++) {
      const lat = nodeLat(g, j);
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        const r = sample(nodeLon(g, i), lat, t, landAt[k] === 1);
        u[k] = r[0];
        v[k] = r[1];
        gust[k] = r[2];
      }
    }
    model.u.push(u);
    model.v.push(v);
    model.gust.push(gust);
  }

  // Station reports: the "true" synthetic wind, rounded the way DHMZ reports it (16-point compass, 0.1 m/s).
  const stationSites = [...PLACES.filter((p) => p.name !== 'Trieste'), { name: 'Gospić', lon: 15.37, lat: 44.55 }, { name: 'Knin', lon: 16.2, lat: 44.04 }];
  const obs: ObsSnapshot[] = [];
  for (const t of times.filter((tt) => tt <= t0)) {
    const stations: Station[] = stationSites.map((p, idx) => {
      const [u, v] = sample(p.lon, p.lat, t, isLandAt(mask, p.lon, p.lat));
      const { speed, fromDeg } = fromUV(u, v);
      const jitter = 1 + 0.12 * Math.sin(t / 3600 + idx * 2.3);
      const spd = Math.round(speed * jitter * 10) / 10;
      const dir = parseDirection(compass(fromDeg));
      return { name: p.name, lon: p.lon, lat: p.lat, fromDeg: spd < 0.3 || dir.kind !== 'deg' ? null : dir.deg, speed: spd < 0.3 ? 0 : spd };
    });
    obs.push({ t, stations });
  }
  return { version: 1, updatedAt: nowS, model, obs, demo: scenario };
}
