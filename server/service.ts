import { decodeBundle } from '../shared/codec.js';
import { HOUR, buildFrame, buildIndex, floorHour, frameTimes } from '../shared/field.js';
import type { Bundle, FieldIndex, Frame } from '../shared/types.js';
import { type Storage, defaultStorage } from './storage.js';

/**
 * Reads the bundle with a short in-memory cache. Fluid-compute instances are reused, so most
 * requests skip storage entirely. The CDN (s-maxage) catches nearly everything else.
 */
const TTL_MS = 60_000;
let cache: { at: number; bundle: Bundle | null; storage: string } | null = null;
let indexMemo: { key: string; index: FieldIndex } | null = null;
const frameMemo = new Map<string, Frame>();

export async function loadBundle(storage: Storage = defaultStorage(), nowMs = Date.now()): Promise<Bundle | null> {
  if (cache && cache.storage === storage.name && nowMs - cache.at < TTL_MS) return cache.bundle;
  const raw = await storage.get();
  const bundle = raw ? decodeBundle(raw) : null;
  if (!cache || cache.bundle?.updatedAt !== bundle?.updatedAt) {
    indexMemo = null;
    frameMemo.clear();
  }
  cache = { at: nowMs, bundle, storage: storage.name };
  return bundle;
}

export function getIndex(bundle: Bundle, nowS: number): FieldIndex {
  const key = `${bundle.updatedAt}:${floorHour(nowS)}`;
  if (indexMemo?.key === key) return indexMemo.index;
  const index = buildIndex(bundle, nowS);
  indexMemo = { key, index };
  return index;
}

/** Resolve a requested time ("latest", ISO string or unix seconds) to one of the available hours. */
export function resolveTime(bundle: Bundle, nowS: number, raw: string | null): number | null {
  const times = frameTimes(bundle, nowS);
  if (!times.length) return null;
  let target: number;
  if (!raw || raw === 'latest' || raw === 'now') target = floorHour(nowS);
  else if (/^\d+$/.test(raw)) target = Number(raw);
  else {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return null;
    target = ms / 1000;
  }
  target = Math.round(target / HOUR) * HOUR;
  return times.reduce((best, t) => (Math.abs(t - target) < Math.abs(best - target) ? t : best), times[0]);
}

export function getFrame(bundle: Bundle, t: number, nowS: number): Frame | null {
  const key = `${bundle.updatedAt}:${floorHour(nowS)}:${t}`;
  const hit = frameMemo.get(key);
  if (hit) return hit;
  const frame = buildFrame(bundle, t, nowS);
  if (frame) {
    if (frameMemo.size > 96) frameMemo.clear();
    frameMemo.set(key, frame);
  }
  return frame;
}

/** True when the data is old enough that a request should trigger a background refresh. */
export function isStale(bundle: Bundle | null, nowS: number): boolean {
  if (!bundle) return true;
  return nowS - bundle.updatedAt > 75 * 60;
}
