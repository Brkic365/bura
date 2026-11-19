import { DOMAIN, OUT_GRID } from './grid.js';
import { type CorrectionOptions, DEFAULT_CORRECTION, type Residual, applyResiduals, bilinear, resample } from './interp.js';
import { REGIME_POINTS } from './places.js';
import { classifyRegime } from './regime.js';
import type { Bundle, FieldIndex, Frame, FrameInfo, FrameKind, FrameStation, ObsSnapshot } from './types.js';
import { toUV } from './wind.js';

export const HOUR = 3600;
/** e-folding time for observation influence in the forecast (nowcast blending). */
export const OBS_DECAY_S = 3 * HOUR;
/** Beyond this lead time the forecast is pure model. */
export const OBS_MAX_LEAD_S = 9 * HOUR;
export const WINDOW_PAST_H = 24;
export const WINDOW_FUTURE_H = 48;
/** Residuals larger than this are treated as bad data and clamped. */
const MAX_RESIDUAL = 20;

export const floorHour = (unix: number) => Math.floor(unix / HOUR) * HOUR;

interface ModelSlice {
  u: Float32Array;
  v: Float32Array;
  gust: Float32Array;
}

function modelAt(bundle: Bundle, t: number): ModelSlice | null {
  const m = bundle.model;
  if (!m) return null;
  const idx = m.times.indexOf(t);
  if (idx < 0) return null;
  return {
    u: resample(m.grid, m.u[idx], OUT_GRID),
    v: resample(m.grid, m.v[idx], OUT_GRID),
    gust: resample(m.grid, m.gust[idx], OUT_GRID),
  };
}

const inDomain = (lon: number, lat: number) =>
  lon >= DOMAIN.lonMin && lon <= DOMAIN.lonMax && lat >= DOMAIN.latMin && lat <= DOMAIN.latMax;

/** Observed-minus-model vectors at each station. Bad or out-of-domain stations are dropped. */
export function residualsFor(snapshot: ObsSnapshot, model: ModelSlice): { residuals: Residual[]; stations: FrameStation[] } {
  const residuals: Residual[] = [];
  const stations: FrameStation[] = [];
  for (const s of snapshot.stations) {
    if (!inDomain(s.lon, s.lat) || !Number.isFinite(s.speed)) continue;
    const mu = bilinear(OUT_GRID, model.u, s.lon, s.lat);
    const mv = bilinear(OUT_GRID, model.v, s.lon, s.lat);
    const [ou, ov] = s.fromDeg === null ? [0, 0] : toUV(s.fromDeg, s.speed);
    const clamp = (x: number) => Math.max(-MAX_RESIDUAL, Math.min(MAX_RESIDUAL, x));
    residuals.push({ lon: s.lon, lat: s.lat, du: clamp(ou - mu), dv: clamp(ov - mv) });
    stations.push({ ...s, modelSpeed: Math.round(Math.hypot(mu, mv) * 10) / 10 });
  }
  return { residuals, stations };
}

/**
 * Builds one output frame (0.1° grid) for whole hour `t`:
 * model (0.25°) → bilinear to 0.1° → IDW residual correction from stations → gust rescale → regime summary.
 */
export function buildFrame(
  bundle: Bundle,
  t: number,
  now: number,
  opts: CorrectionOptions = DEFAULT_CORRECTION,
): Frame | null {
  const model = modelAt(bundle, t);
  if (!model) return null;

  const latest = bundle.obs.length ? bundle.obs[bundle.obs.length - 1] : null;
  const exact = bundle.obs.find((o) => o.t === t) ?? null;

  let kind: FrameKind = t > floorHour(now) ? 'forecast' : 'model';
  let residuals: Residual[] = [];
  let stations: FrameStation[] = [];
  let strength = 0;
  let obsT: number | null = null;

  if (exact) {
    ({ residuals, stations } = residualsFor(exact, model));
    strength = 1;
    obsT = exact.t;
    kind = 'obs';
  } else if (latest && t > latest.t && t - latest.t <= OBS_MAX_LEAD_S) {
    // Nowcast blending: carry the latest observed bias forward, fading exponentially with lead time.
    const base = modelAt(bundle, latest.t);
    if (base) {
      ({ residuals } = residualsFor(latest, base));
      strength = Math.exp(-(t - latest.t) / OBS_DECAY_S);
      obsT = latest.t;
    }
  }

  const corrected = applyResiduals(OUT_GRID, model.u, model.v, residuals, { ...opts, strength: opts.strength * strength });

  // Gusts: DHMZ reports no gusts, so scale the model gust by the corrected/model speed ratio.
  const gust = new Float32Array(model.gust.length);
  for (let k = 0; k < gust.length; k++) {
    const ms = Math.hypot(model.u[k], model.v[k]);
    const cs = Math.hypot(corrected.u[k], corrected.v[k]);
    const ratio = Math.min(3, Math.max(0.5, cs / Math.max(ms, 1)));
    gust[k] = Math.max(model.gust[k] * ratio, cs);
  }

  const summary = classifyRegime(
    REGIME_POINTS.map((p) => ({
      name: p.name,
      lon: p.lon,
      lat: p.lat,
      u: bilinear(OUT_GRID, corrected.u, p.lon, p.lat),
      v: bilinear(OUT_GRID, corrected.v, p.lon, p.lat),
      gust: bilinear(OUT_GRID, gust, p.lon, p.lat),
    })),
  );

  return {
    t,
    kind,
    obsT,
    obsWeight: Math.round(strength * 100) / 100,
    grid: OUT_GRID,
    u: corrected.u,
    v: corrected.v,
    gust,
    stations,
    summary,
  };
}

/** Hours to offer: [now − 24 h, now + 48 h] ∩ the hours the model covers. */
export function frameTimes(bundle: Bundle, now: number): number[] {
  if (!bundle.model) return [];
  const t0 = floorHour(now) - WINDOW_PAST_H * HOUR;
  const t1 = floorHour(now) + WINDOW_FUTURE_H * HOUR;
  return bundle.model.times.filter((t) => t >= t0 && t <= t1);
}

export function buildIndex(bundle: Bundle, now: number): FieldIndex {
  const frames: FrameInfo[] = [];
  for (const t of frameTimes(bundle, now)) {
    const f = buildFrame(bundle, t, now);
    if (f) frames.push({ t, kind: f.kind, summary: f.summary });
  }
  return {
    updatedAt: bundle.updatedAt,
    modelFetchedAt: bundle.model?.fetchedAt ?? null,
    latestObsT: bundle.obs.length ? bundle.obs[bundle.obs.length - 1].t : null,
    nowT: floorHour(now),
    grid: OUT_GRID,
    frames,
    ...(bundle.demo ? { demo: bundle.demo } : {}),
  };
}
