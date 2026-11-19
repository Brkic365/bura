/**
 * GET /api/field?t=<ISO | unix seconds | latest>
 *
 * Returns one corrected wind frame on the 0.1° grid as a compact binary "BURF" payload
 * (~28 kB: JSON header + int16 u/v/gust). See shared/codec.ts. Debugging: `&format=json` for
 * everything as JSON, `&format=meta` for the header only (stations, summary, no grids).
 */
import { encodeFrame } from '../shared/codec.js';
import { getFrame, loadBundle, resolveTime } from '../server/service.js';
import { CDN_CACHE, json, kickIfStale } from './_lib.js';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const bundle = await loadBundle();
    kickIfStale(bundle, nowS);
    if (!bundle?.model) return json({ error: 'no data yet' }, { status: 503 });
    const t = resolveTime(bundle, nowS, url.searchParams.get('t'));
    if (t === null) return json({ error: 'bad or unavailable time' }, { status: 400 });
    const frame = getFrame(bundle, t, nowS);
    if (!frame) return json({ error: 'frame unavailable' }, { status: 404 });

    if (url.searchParams.get('format') === 'meta') {
      const { u: _u, v: _v, gust: _g, ...meta } = frame;
      return json(meta, { cache: CDN_CACHE });
    }
    if (url.searchParams.get('format') === 'json') {
      const round = (a: Float32Array) => Array.from(a, (x) => Math.round(x * 100) / 100);
      return json({ ...frame, u: round(frame.u), v: round(frame.v), gust: round(frame.gust) }, { cache: CDN_CACHE });
    }
    return new Response(encodeFrame(frame), {
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': CDN_CACHE,
        'access-control-allow-origin': '*',
        'x-bura-time': new Date(t * 1000).toISOString(),
      },
    });
  } catch (err) {
    console.error('[bura] /api/field', err);
    return json({ error: 'internal error' }, { status: 500 });
  }
}
