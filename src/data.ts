import { decodeFrame } from '../shared/codec';
import type { DemoScenario } from '../shared/demo';
import type { FieldIndex, Frame } from '../shared/types';

export interface Source {
  kind: 'live' | 'demo';
  label: string;
  index(): Promise<FieldIndex>;
  frame(t: number): Promise<Frame>;
}

/** Live data from the API. Frames are cached and requests for the same frame are shared. */
export function liveSource(base = ''): Source {
  const cache = new Map<number, Promise<Frame>>();
  return {
    kind: 'live',
    label: 'Live',
    async index() {
      const res = await fetch(`${base}/api/frames`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`/api/frames ${res.status}`);
      const idx = (await res.json()) as FieldIndex;
      if (!idx.frames?.length) throw new Error('no frames');
      return idx;
    },
    frame(t) {
      let p = cache.get(t);
      if (!p) {
        p = fetch(`${base}/api/field?t=${t}`).then(async (res) => {
          if (!res.ok) throw new Error(`/api/field ${res.status}`);
          return decodeFrame(new Uint8Array(await res.arrayBuffer()));
        });
        p.catch(() => cache.delete(t));
        cache.set(t, p);
        if (cache.size > 80) cache.delete(cache.keys().next().value!);
      }
      return p;
    },
  };
}

/**
 * Synthetic scenarios, computed with the same pipeline the server uses (shared/field.ts), in a
 * Web Worker so the main thread stays free. The generator ships as a separate chunk and costs
 * nothing in live mode.
 */
export async function demoSource(scenario: DemoScenario): Promise<Source> {
  const worker = new Worker(new URL('./demo.worker.ts', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data);
  };
  const call = (msg: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id });
    });
  const indexP: Promise<FieldIndex> = call({ type: 'init', scenario, now: Math.floor(Date.now() / 1000) }).then((r) => r.index);
  const frames = new Map<number, Promise<Frame>>();
  return {
    kind: 'demo',
    label: `Demo · ${scenario}`,
    index: () => indexP,
    frame(t) {
      let f = frames.get(t);
      if (!f) {
        f = indexP.then(() => call({ type: 'frame', t })).then((r) => r.frame as Frame);
        frames.set(t, f);
      }
      return f;
    },
  };
}
