/** GET /api/frames: available hours with a regime summary for each, used by the time scrubber. */
import { getIndex, loadBundle } from '../server/service.js';
import { CDN_CACHE, json, kickIfStale } from './_lib.js';

export async function GET(): Promise<Response> {
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const bundle = await loadBundle();
    kickIfStale(bundle, nowS);
    if (!bundle?.model) return json({ error: 'no data yet', hint: 'run the ingest job' }, { status: 503 });
    return json(getIndex(bundle, nowS), { cache: CDN_CACHE });
  } catch (err) {
    console.error('[bura] /api/frames', err);
    return json({ error: 'internal error' }, { status: 500 });
  }
}
