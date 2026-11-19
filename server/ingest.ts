import { decodeBundle, encodeBundle } from '../shared/codec.js';
import { HOUR } from '../shared/field.js';
import type { Bundle } from '../shared/types.js';
import { fetchDhmz } from './dhmz.js';
import { fetchOpenMeteo } from './openmeteo.js';
import type { Storage } from './storage.js';

/** Refresh the model this often. Upstream models update every 3 h, and this keeps us under fair use. */
export const MODEL_REFRESH_S = 3 * HOUR - 10 * 60;
/** Keep 30 h of station history (the window shows 24 h). */
export const OBS_RETENTION_S = 30 * HOUR;

export interface IngestReport {
  storage: string;
  changed: boolean;
  dhmz: { ok: boolean; t?: number; stations?: number; new?: boolean; error?: string };
  model: { ok: boolean; refreshed: boolean; times?: number; error?: string };
  ms: number;
}

export interface IngestDeps {
  storage: Storage;
  fetchImpl?: typeof fetch;
  now?: () => number;
  force?: boolean;
}

export const emptyBundle = (): Bundle => ({ version: 1, updatedAt: 0, model: null, obs: [] });

/**
 * One ingest pass (safe to run every 10–15 minutes):
 *  1. Read the current bundle.
 *  2. Fetch DHMZ. If the hourly observation is new, append it and drop anything older than 30 h.
 *  3. If the model is older than ~3 h (or `force`), refetch the Open-Meteo grid.
 *  4. Write back only if something changed.
 * Each source fails on its own, so a DHMZ outage still lets the model refresh, and the reverse.
 */
export async function runIngest({ storage, fetchImpl = fetch, now = Date.now, force = false }: IngestDeps): Promise<IngestReport> {
  const started = now();
  const nowS = Math.floor(started / 1000);
  const raw = await storage.get();
  let bundle: Bundle;
  try {
    bundle = raw ? decodeBundle(raw) : emptyBundle();
  } catch {
    bundle = emptyBundle(); // corrupt or old format: start again
  }
  if (bundle.demo) bundle = emptyBundle(); // never mix demo data with live data
  let changed = false;
  const report: IngestReport = { storage: storage.name, changed: false, dhmz: { ok: false }, model: { ok: false, refreshed: false }, ms: 0 };

  try {
    const snap = await fetchDhmz(fetchImpl);
    const isNew = !bundle.obs.some((o) => o.t === snap.t) && snap.stations.length > 0;
    if (isNew) {
      bundle.obs = [...bundle.obs, snap].sort((a, b) => a.t - b.t);
      changed = true;
    }
    report.dhmz = { ok: true, t: snap.t, stations: snap.stations.length, new: isNew };
  } catch (err) {
    report.dhmz = { ok: false, error: String((err as Error)?.message ?? err) };
  }

  const before = bundle.obs.length;
  bundle.obs = bundle.obs.filter((o) => o.t >= nowS - OBS_RETENTION_S);
  if (bundle.obs.length !== before) changed = true;

  const stale = !bundle.model || nowS - bundle.model.fetchedAt >= MODEL_REFRESH_S;
  if (force || stale) {
    try {
      bundle.model = await fetchOpenMeteo(fetchImpl, started);
      changed = true;
      report.model = { ok: true, refreshed: true, times: bundle.model.times.length };
    } catch (err) {
      report.model = { ok: false, refreshed: false, error: String((err as Error)?.message ?? err) };
    }
  } else {
    report.model = { ok: true, refreshed: false, times: bundle.model?.times.length };
  }

  if (changed) {
    bundle.updatedAt = nowS;
    await storage.put(encodeBundle(bundle));
  }
  report.changed = changed;
  report.ms = now() - started;
  return report;
}
