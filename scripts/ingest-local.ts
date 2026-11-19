/**
 * Run one ingest pass from your machine: fetches DHMZ + Open-Meteo and writes .data/bundle.bin
 * (or Vercel Blob, if BLOB_READ_WRITE_TOKEN is set).
 *   npm run ingest            # normal pass
 *   npm run ingest -- --force # refetch the model even if it is fresh
 */
import { runIngest } from '../server/ingest';
import { defaultStorage } from '../server/storage';

const report = await runIngest({ storage: defaultStorage(), force: process.argv.includes('--force') });
console.log(JSON.stringify(report, null, 2));
if (!report.dhmz.ok && !report.model.ok) process.exit(1);
