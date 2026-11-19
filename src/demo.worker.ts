/**
 * Builds the synthetic demo scenarios off the main thread. Generating 73 hourly frames and
 * running the full correction pipeline on each takes a few hundred ms, which would otherwise
 * block input and first paint.
 */
import { makeDemoBundle, type DemoScenario } from '../shared/demo';
import { buildFrame, buildIndex } from '../shared/field';
import { DOMAIN } from '../shared/grid';
import { buildLandMask } from '../shared/landmask';
import type { Bundle } from '../shared/types';

// Typed locally so this file doesn't pull the WebWorker lib into the DOM program.
const ctx = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(msg: unknown, transfer?: Transferable[]): void };

let bundle: Bundle | null = null;
let now = 0;

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data as { id: number; type: 'init'; scenario: DemoScenario; now: number } | { id: number; type: 'frame'; t: number };
  try {
    if (m.type === 'init') {
      now = m.now;
      const mask = buildLandMask(DOMAIN.lonMin, DOMAIN.latMin, DOMAIN.lonMax, DOMAIN.latMax, 0.02);
      bundle = makeDemoBundle(m.scenario, now, mask);
      ctx.postMessage({ id: m.id, index: buildIndex(bundle, now) });
    } else if (bundle) {
      const f = buildFrame(bundle, m.t, now);
      if (!f) throw new Error(`no frame for ${m.t}`);
      ctx.postMessage({ id: m.id, frame: f }, [f.u.buffer, f.v.buffer, f.gust.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ id: m.id, error: String(err) });
  }
};
