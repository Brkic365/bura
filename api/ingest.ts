/**
 * GET|POST /api/ingest: fetch DHMZ + Open-Meteo, update the stored snapshot.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`. Vercel Cron sends this header automatically when
 * CRON_SECRET is set, and the GitHub Actions workflow sends it too. `?force=1` refetches the model now.
 */
import { runIngest } from '../server/ingest.js';
import { defaultStorage } from '../server/storage.js';
import { json } from './_lib.js';

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return json({ error: 'unauthorized' }, { status: 401 });
  const force = new URL(request.url).searchParams.get('force') === '1';
  try {
    const report = await runIngest({ storage: defaultStorage(), force });
    console.log('[bura] ingest', JSON.stringify(report));
    return json(report, { status: report.dhmz.ok || report.model.ok ? 200 : 502 });
  } catch (err) {
    console.error('[bura] ingest failed', err);
    return json({ error: String((err as Error)?.message ?? err) }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
