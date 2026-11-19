import type { GridSpec } from './grid.js';
import type { RegimeSummary } from './regime.js';

/** One station observation. fromDeg is null for calm. */
export interface Station {
  name: string;
  lon: number;
  lat: number;
  fromDeg: number | null;
  speed: number;
}

export interface ObsSnapshot {
  /** Observation time, unix seconds (whole UTC hour). */
  t: number;
  stations: Station[];
}

/** Hourly model series on MODEL_GRID: u, v, gust (m/s), one Float32Array per time step. */
export interface ModelSeries {
  fetchedAt: number;
  source: string;
  grid: GridSpec;
  times: number[];
  u: Float32Array[];
  v: Float32Array[];
  gust: Float32Array[];
}

/** Everything the ingest job persists: one object, written only when something changed. */
export interface Bundle {
  version: 1;
  updatedAt: number;
  model: ModelSeries | null;
  obs: ObsSnapshot[];
  /** Set for synthetic demo bundles. */
  demo?: string;
}

/**
 * How a frame was made:
 * - obs: station observations for that hour blended into the model
 * - model: past hour with no station data
 * - forecast: future hour, with the latest observation residuals decaying into it
 */
export type FrameKind = 'obs' | 'model' | 'forecast';

export interface FrameStation extends Station {
  /** Model speed at the station before correction, kept so you can compare. */
  modelSpeed: number;
}

export interface Frame {
  t: number;
  kind: FrameKind;
  /** Time of the observations that influenced this frame, if any. */
  obsT: number | null;
  /** 0..1, how strongly observations were applied. */
  obsWeight: number;
  grid: GridSpec;
  u: Float32Array;
  v: Float32Array;
  gust: Float32Array;
  stations: FrameStation[];
  summary: RegimeSummary;
}

export interface FrameInfo {
  t: number;
  kind: FrameKind;
  summary: RegimeSummary;
}

export interface FieldIndex {
  updatedAt: number;
  modelFetchedAt: number | null;
  latestObsT: number | null;
  /** The whole hour the client should treat as "now". */
  nowT: number;
  grid: GridSpec;
  frames: FrameInfo[];
  demo?: string;
}
