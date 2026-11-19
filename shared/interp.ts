import { type GridSpec, cellCount, distanceKm, nodeLat, nodeLon } from './grid.js';

/** Bilinear sample of a grid field at (lon, lat). Coordinates outside the grid are clamped to the edge. */
export function bilinear(g: GridSpec, data: ArrayLike<number>, lon: number, lat: number): number {
  const fx = Math.min(Math.max((lon - g.lon0) / g.dlon, 0), g.nx - 1);
  const fy = Math.min(Math.max((lat - g.lat0) / g.dlat, 0), g.ny - 1);
  const i0 = Math.min(Math.floor(fx), g.nx - 2);
  const j0 = Math.min(Math.floor(fy), g.ny - 2);
  const tx = fx - i0;
  const ty = fy - j0;
  const k = j0 * g.nx + i0;
  const a = data[k];
  const b = data[k + 1];
  const c = data[k + g.nx];
  const d = data[k + g.nx + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Resample a field from one regular grid onto another with bilinear interpolation. */
export function resample(src: GridSpec, data: ArrayLike<number>, dst: GridSpec): Float32Array {
  const out = new Float32Array(cellCount(dst));
  for (let j = 0; j < dst.ny; j++) {
    const lat = nodeLat(dst, j);
    for (let i = 0; i < dst.nx; i++) out[j * dst.nx + i] = bilinear(src, data, nodeLon(dst, i), lat);
  }
  return out;
}

/**
 * Fill nodes that weren't sampled (mask = 0) by bilinear interpolation from the 0.5° lattice
 * (even i, even j), which is always sampled. See modelSampleMask().
 */
export function fillFromLattice(g: GridSpec, data: Float32Array, mask: Uint8Array): Float32Array {
  const out = data.slice();
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      if (mask[k]) continue;
      const i0 = i - (i % 2);
      const j0 = j - (j % 2);
      const i1 = Math.min(i0 + 2, g.nx - 1 - ((g.nx - 1) % 2));
      const j1 = Math.min(j0 + 2, g.ny - 1 - ((g.ny - 1) % 2));
      const tx = i1 === i0 ? 0 : (i - i0) / (i1 - i0);
      const ty = j1 === j0 ? 0 : (j - j0) / (j1 - j0);
      const v = (ii: number, jj: number) => data[jj * g.nx + ii];
      out[k] = (v(i0, j0) * (1 - tx) + v(i1, j0) * tx) * (1 - ty) + (v(i0, j1) * (1 - tx) + v(i1, j1) * tx) * ty;
    }
  }
  return out;
}

export interface ScatterPoint {
  lon: number;
  lat: number;
  value: number;
}

/**
 * Plain Shepard inverse-distance weighting. Exact at data points, and the result always lies within
 * [min, max] of the inputs. `radiusKm` limits which points count; outside every radius → NaN.
 */
export function idw(points: ScatterPoint[], lon: number, lat: number, power = 2, radiusKm = Infinity): number {
  let wSum = 0;
  let vSum = 0;
  for (const p of points) {
    const d = distanceKm(lon, lat, p.lon, p.lat);
    if (d < 1e-6) return p.value;
    if (d > radiusKm) continue;
    const w = 1 / Math.pow(d, power);
    wSum += w;
    vSum += w * p.value;
  }
  return wSum > 0 ? vSum / wSum : NaN;
}

export interface Residual {
  lon: number;
  lat: number;
  du: number;
  dv: number;
}

export interface CorrectionOptions {
  /** Hard cut-off: a station has no influence beyond this distance. */
  radiusKm: number;
  /** Background-weight length scale. The correction keeps full strength well inside it and fades beyond. */
  coreKm: number;
  /** Scales the whole correction (used to decay observation influence into the forecast). */
  strength: number;
}

export const DEFAULT_CORRECTION: CorrectionOptions = { radiusKm: 45, coreKm: 12, strength: 1 };

/**
 * IDW residual correction ("successive correction" with Shepard weights).
 *
 *   field(x) = model(x) + Σ wᵢ rᵢ / (w₀ + Σ wᵢ)
 *   wᵢ = taper(dᵢ/R) / dᵢ²,  taper(s) = (1 − s²)² for s < 1, otherwise 0
 *   w₀ = 1 / L²
 *
 * rᵢ is station i's observed-minus-model wind vector. At a station dᵢ → 0, so the field matches the
 * observation exactly. Far from all stations Σwᵢ ≪ w₀ and the field returns smoothly to the model.
 * Plain IDW would extend the nearest station's error over the whole open sea. u and v are corrected
 * separately, never speed and direction, so opposing winds can't average into a fake calm at
 * the wrong angle.
 */
export function applyResiduals(
  g: GridSpec,
  u: Float32Array,
  v: Float32Array,
  residuals: Residual[],
  opts: CorrectionOptions = DEFAULT_CORRECTION,
): { u: Float32Array; v: Float32Array } {
  const outU = u.slice();
  const outV = v.slice();
  if (!residuals.length || opts.strength <= 0) return { u: outU, v: outV };
  const w0 = 1 / (opts.coreKm * opts.coreKm);
  const R = opts.radiusKm;
  for (let j = 0; j < g.ny; j++) {
    const lat = nodeLat(g, j);
    for (let i = 0; i < g.nx; i++) {
      const lon = nodeLon(g, i);
      let wSum = 0;
      let du = 0;
      let dv = 0;
      let exact = -1;
      for (let s = 0; s < residuals.length; s++) {
        const r = residuals[s];
        const d = distanceKm(lon, lat, r.lon, r.lat);
        if (d >= R) continue;
        if (d < 0.05) {
          exact = s;
          break;
        }
        const t = 1 - (d / R) * (d / R);
        const w = (t * t) / (d * d);
        wSum += w;
        du += w * r.du;
        dv += w * r.dv;
      }
      const k = j * g.nx + i;
      if (exact >= 0) {
        outU[k] += residuals[exact].du * opts.strength;
        outV[k] += residuals[exact].dv * opts.strength;
      } else if (wSum > 0) {
        const norm = opts.strength / (w0 + wSum);
        outU[k] += du * norm;
        outV[k] += dv * norm;
      }
    }
  }
  return { u: outU, v: outV };
}
