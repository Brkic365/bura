/**
 * Writes a synthetic bundle to .data/bundle.bin so the local API works offline.
 *   npm run seed:demo -- jugo      (bura | jugo | maestral, default bura)
 */
import { encodeBundle } from '../shared/codec';
import { DEMO_SCENARIOS, type DemoScenario, makeDemoBundle } from '../shared/demo';
import { DOMAIN } from '../shared/grid';
import { buildLandMask } from '../shared/landmask';
import { fileStorage } from '../server/storage';

const scenario = (process.argv[2] ?? 'bura') as DemoScenario;
if (!DEMO_SCENARIOS.includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
const mask = buildLandMask(DOMAIN.lonMin, DOMAIN.latMin, DOMAIN.lonMax, DOMAIN.latMax, 0.02);
const bundle = makeDemoBundle(scenario, Math.floor(Date.now() / 1000), mask);
// Demo bundles are flagged; the live ingest discards them.
const storage = fileStorage();
await storage.put(encodeBundle(bundle));
console.log(`wrote ${scenario} demo bundle to ${storage.name}`);
