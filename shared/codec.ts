/**
 * Binary containers: [4-byte magic][u32 LE header length][UTF-8 JSON header][pad to 4][Int16 LE payload].
 * Wind values are stored as int16 at 0.01 m/s resolution (±327 m/s).
 *
 * - "BURB" bundle: what the ingest job stores (model on the 0.25° grid plus observation history).
 * - "BURF" frame: what /api/field returns (one corrected 0.1° frame, ~28 kB).
 */
import type { GridSpec } from './grid.js';
import type { RegimeSummary } from './regime.js';
import type { Bundle, Frame, FrameKind, FrameStation, ModelSeries } from './types.js';

export const SCALE = 0.01;
const enc = new TextEncoder();
const dec = new TextDecoder();

function pack(magic: string, header: unknown, arrays: Float32Array[]): Uint8Array<ArrayBuffer> {
  const h = enc.encode(JSON.stringify(header));
  const headerEnd = 8 + h.length;
  const dataStart = (headerEnd + 3) & ~3;
  const n = arrays.reduce((s, a) => s + a.length, 0);
  const buf = new ArrayBuffer(dataStart + n * 2);
  const bytes = new Uint8Array(buf);
  bytes.set(enc.encode(magic), 0);
  const view = new DataView(buf);
  view.setUint32(4, h.length, true);
  bytes.set(h, 8);
  let off = dataStart;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++, off += 2) {
      const q = Math.round(a[i] / SCALE);
      view.setInt16(off, q > 32767 ? 32767 : q < -32768 ? -32768 : q, true);
    }
  }
  return bytes;
}

function unpack(magic: string, input: Uint8Array): { header: any; read: (count: number) => Float32Array } {
  if (input.length < 8 || dec.decode(input.subarray(0, 4)) !== magic) throw new Error(`not a ${magic} payload`);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const hLen = view.getUint32(4, true);
  const header = JSON.parse(dec.decode(input.subarray(8, 8 + hLen)));
  let off = (8 + hLen + 3) & ~3;
  const read = (count: number) => {
    if (off + count * 2 > input.length) throw new Error(`${magic} payload truncated`);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++, off += 2) out[i] = view.getInt16(off, true) * SCALE;
    return out;
  };
  return { header, read };
}

export function encodeBundle(b: Bundle): Uint8Array<ArrayBuffer> {
  const { model, ...rest } = b;
  const header = {
    ...rest,
    model: model ? { fetchedAt: model.fetchedAt, source: model.source, grid: model.grid, times: model.times } : null,
  };
  const arrays: Float32Array[] = [];
  if (model) for (let i = 0; i < model.times.length; i++) arrays.push(model.u[i], model.v[i], model.gust[i]);
  return pack('BURB', header, arrays);
}

export function decodeBundle(input: Uint8Array): Bundle {
  const { header, read } = unpack('BURB', input);
  let model: ModelSeries | null = null;
  if (header.model) {
    const g: GridSpec = header.model.grid;
    const n = g.nx * g.ny;
    model = { ...header.model, u: [], v: [], gust: [] } as ModelSeries;
    for (let i = 0; i < header.model.times.length; i++) {
      model.u.push(read(n));
      model.v.push(read(n));
      model.gust.push(read(n));
    }
  }
  return { ...header, model } as Bundle;
}

export interface FrameHeader {
  t: number;
  kind: FrameKind;
  obsT: number | null;
  obsWeight: number;
  grid: GridSpec;
  stations: FrameStation[];
  summary: RegimeSummary;
}

export function encodeFrame(f: Frame): Uint8Array<ArrayBuffer> {
  const header: FrameHeader = {
    t: f.t,
    kind: f.kind,
    obsT: f.obsT,
    obsWeight: f.obsWeight,
    grid: f.grid,
    stations: f.stations,
    summary: f.summary,
  };
  return pack('BURF', header, [f.u, f.v, f.gust]);
}

export function decodeFrame(input: Uint8Array): Frame {
  const { header, read } = unpack('BURF', input);
  const h = header as FrameHeader;
  const n = h.grid.nx * h.grid.ny;
  return { ...h, u: read(n), v: read(n), gust: read(n) };
}
