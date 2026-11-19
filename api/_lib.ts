import { waitUntil } from '@vercel/functions';
import { runIngest } from '../server/ingest.js';
import { isStale } from '../server/service.js';
import { defaultStorage } from '../server/storage.js';
import type { Bundle } from '../shared/types.js';

let lastKick = 0;

/**
 * Self-healing refresh: if the stored data is stale when a visitor arrives, run an ingest after
 * the response is sent. The scheduled job (GitHub Actions every 15 min, plus Vercel's daily cron
 * on Hobby) is the main driver. This only covers gaps. Throttled per instance.
 */
export function kickIfStale(bundle: Bundle | null, nowS: number) {
  if (!isStale(bundle, nowS) || Date.now() - lastKick < 10 * 60_000) return;
  lastKick = Date.now();
  try {
    waitUntil(runIngest({ storage: defaultStorage() }).catch((e) => console.error('[bura] background ingest failed', e)));
  } catch {
    // waitUntil is unavailable outside Vercel (e.g. in the Vite dev server): skip.
  }
}

export const json = (body: unknown, init: ResponseInit & { cache?: string } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': init.cache ?? 'no-store',
      'access-control-allow-origin': '*',
    },
  });

/** CDN caching: fresh for 2 min, then served stale while revalidating for up to 30 min. */
export const CDN_CACHE = 'public, max-age=60, s-maxage=120, stale-while-revalidate=1800';
