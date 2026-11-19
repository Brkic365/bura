import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeBundle, decodeFrame, encodeBundle, encodeFrame } from '../shared/codec';
import { makeDemoBundle } from '../shared/demo';
import { buildFrame, buildIndex } from '../shared/field';
import { MODEL_GRID, OUT_GRID, cellCount } from '../shared/grid';
import { bilinear } from '../shared/interp';
import { buildLandMask, isLandAt } from '../shared/landmask';
import type { Bundle } from '../shared/types';
import { fromUV } from '../shared/wind';
import { decodeXmlBytes, parseDhmzXml } from '../server/dhmz';
import { runIngest } from '../server/ingest';
import { assembleSeries, buildUrl, sampleNodes } from '../server/openmeteo';
import type { Storage } from '../server/storage';

const XML = readFileSync(new URL('./fixtures/hrvatska_n.xml', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 10, 19, 17, 20) / 1000; // 18:20 Zagreb

describe('DHMZ parser', () => {
  const snap = parseDhmzXml(XML);

  it('converts the local DatumTermin to UTC', () => {
    expect(snap.t).toBe(Date.UTC(2026, 10, 19, 17) / 1000);
  });

  it('keeps valid stations, marks calm, drops missing data and mountain tops', () => {
    const names = snap.stations.map((s) => s.name);
    expect(names).toEqual(['Senj', 'Split-Marjan', 'Dubrovnik', 'Zagreb-Maksimir']);
    expect(snap.stations[0]).toMatchObject({ fromDeg: 45, speed: 17.2, lat: 44.993, lon: 14.903 });
    expect(snap.stations[2]).toMatchObject({ fromDeg: null, speed: 0 });
  });

  it('decodes windows-1250 feeds using the XML prolog', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="windows-1250"?><a>'), 0x9e, ...new TextEncoder().encode('</a>')]);
    expect(decodeXmlBytes(bytes)).toContain('<a>ž</a>');
  });

  it('rejects documents without the expected root', () => {
    expect(() => parseDhmzXml('<foo/>')).toThrow();
  });
});

/** Fake Open-Meteo: uniform bura-like NE wind (from 45°) at `speed` m/s. */
function fakeOpenMeteo(speed: number, hours = 96) {
  const t0 = Date.UTC(2026, 10, 18, 0) / 1000;
  const time = Array.from({ length: hours }, (_, i) => t0 + i * 3600);
  return (url: string) => {
    const n = new URL(url).searchParams.get('latitude')!.split(',').length;
    const loc = {
      latitude: 0,
      longitude: 0,
      hourly: { time, wind_speed_10m: time.map(() => speed), wind_direction_10m: time.map(() => 45), wind_gusts_10m: time.map(() => speed * 1.6) },
    };
    return Array.from({ length: n }, () => loc);
  };
}

function memoryStorage(): Storage & { bytes: Uint8Array | null; puts: number } {
  const s = {
    name: 'memory',
    bytes: null as Uint8Array | null,
    puts: 0,
    async get() {
      return s.bytes;
    },
    async put(b: Uint8Array) {
      s.bytes = b;
      s.puts++;
    },
  };
  return s;
}

function fakeFetch(om: (url: string) => unknown, dhmzXml = XML): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('vrijeme.hr')) return new Response(dhmzXml, { status: 200 });
    if (url.includes('open-meteo')) return new Response(JSON.stringify(om(url)), { status: 200 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

describe('Open-Meteo assembly', () => {
  it('builds request URLs within a sane length', () => {
    const nodes = sampleNodes();
    expect(buildUrl(nodes.slice(0, 180)).length).toBeLessThan(4000);
  });

  it('assembles a full grid with u/v from speed+direction', () => {
    const nodes = sampleNodes();
    const series = assembleSeries(nodes, fakeOpenMeteo(10)(buildUrl(nodes)) as any, 0);
    expect(series.times.length).toBe(96);
    expect(series.u[0].length).toBe(cellCount(MODEL_GRID));
    for (const k of [0, 100, 500, 776]) {
      const r = fromUV(series.u[5][k], series.v[5][k]);
      expect(r.speed).toBeCloseTo(10, 3);
      expect(r.fromDeg).toBeCloseTo(45, 3);
    }
  });
});

describe('ingest → frame pipeline', () => {
  it('stores model + observations, and only writes when something changed', async () => {
    const storage = memoryStorage();
    const fetchImpl = fakeFetch(fakeOpenMeteo(8));
    const now = () => NOW * 1000;
    const r1 = await runIngest({ storage, fetchImpl, now });
    expect(r1.dhmz).toMatchObject({ ok: true, new: true, stations: 4 });
    expect(r1.model).toMatchObject({ ok: true, refreshed: true });
    expect(storage.puts).toBe(1);

    const r2 = await runIngest({ storage, fetchImpl, now: () => NOW * 1000 + 15 * 60_000 });
    expect(r2.changed).toBe(false);
    expect(storage.puts).toBe(1);

    const bundle = decodeBundle(storage.bytes!);
    expect(bundle.obs).toHaveLength(1);
    expect(bundle.model!.times).toHaveLength(96);
  });

  it('survives a DHMZ outage and still refreshes the model', async () => {
    const storage = memoryStorage();
    const failing = (async (input: RequestInfo | URL) => {
      if (String(input).includes('vrijeme.hr')) throw new Error('ECONNRESET');
      return fakeFetch(fakeOpenMeteo(8))(input);
    }) as typeof fetch;
    const r = await runIngest({ storage, fetchImpl: failing, now: () => NOW * 1000 });
    expect(r.dhmz.ok).toBe(false);
    expect(r.model.refreshed).toBe(true);
    expect(storage.puts).toBe(1);
  });

  it('pulls the field toward station observations in observed frames', async () => {
    const storage = memoryStorage();
    await runIngest({ storage, fetchImpl: fakeFetch(fakeOpenMeteo(8)), now: () => NOW * 1000 });
    const bundle = decodeBundle(storage.bytes!);
    const obsT = bundle.obs[0].t;
    const f = buildFrame(bundle, obsT, NOW)!;
    expect(f.kind).toBe('obs');
    const atSenj = fromUV(bilinear(OUT_GRID, f.u, 14.903, 44.993), bilinear(OUT_GRID, f.v, 14.903, 44.993)).speed;
    expect(atSenj).toBeGreaterThan(13); // model 8 m/s, station 17.2 m/s
    const openSea = fromUV(bilinear(OUT_GRID, f.u, 14.0, 43.0), bilinear(OUT_GRID, f.v, 14.0, 43.0)).speed;
    expect(openSea).toBeCloseTo(8, 1); // far from stations → model
    // Gusts follow the correction.
    expect(bilinear(OUT_GRID, f.gust, 14.903, 44.993)).toBeGreaterThan(atSenj);
  });

  it('fades observation influence into the forecast', async () => {
    const storage = memoryStorage();
    await runIngest({ storage, fetchImpl: fakeFetch(fakeOpenMeteo(8)), now: () => NOW * 1000 });
    const bundle = decodeBundle(storage.bytes!);
    const t0 = bundle.obs[0].t;
    const speedAt = (t: number) => {
      const f = buildFrame(bundle, t, NOW)!;
      return fromUV(bilinear(OUT_GRID, f.u, 14.903, 44.993), bilinear(OUT_GRID, f.v, 14.903, 44.993)).speed;
    };
    const s1 = speedAt(t0 + 3600);
    const s6 = speedAt(t0 + 6 * 3600);
    const s12 = speedAt(t0 + 12 * 3600);
    expect(s1).toBeGreaterThan(s6);
    expect(s6).toBeGreaterThan(s12);
    expect(s12).toBeCloseTo(8, 1);
    expect(buildFrame(bundle, t0 + 3600, NOW)!.kind).toBe('forecast');
  });

  it('builds an index covering −24 h … +48 h', async () => {
    const storage = memoryStorage();
    await runIngest({ storage, fetchImpl: fakeFetch(fakeOpenMeteo(12)), now: () => NOW * 1000 });
    const idx = buildIndex(decodeBundle(storage.bytes!), NOW);
    expect(idx.frames.length).toBe(73);
    expect(idx.frames.every((f) => f.summary.regime === 'bura')).toBe(true);
  });
});

describe('codecs', () => {
  it('round-trips a bundle at 0.01 m/s precision', async () => {
    const storage = memoryStorage();
    await runIngest({ storage, fetchImpl: fakeFetch(fakeOpenMeteo(9.37)), now: () => NOW * 1000 });
    const b = decodeBundle(storage.bytes!);
    const again = decodeBundle(encodeBundle(b));
    expect(again.obs).toEqual(b.obs);
    expect(Array.from(again.model!.u[3])).toEqual(Array.from(b.model!.u[3]));
  });

  it('round-trips a frame and stays compact', async () => {
    const storage = memoryStorage();
    await runIngest({ storage, fetchImpl: fakeFetch(fakeOpenMeteo(9.37)), now: () => NOW * 1000 });
    const b: Bundle = decodeBundle(storage.bytes!);
    const f = buildFrame(b, b.obs[0].t, NOW)!;
    const bytes = encodeFrame(f);
    expect(bytes.length).toBeLessThan(32_000);
    const d = decodeFrame(bytes);
    expect(d.summary).toEqual(f.summary);
    for (let k = 0; k < f.u.length; k += 97) expect(d.u[k]).toBeCloseTo(f.u[k], 2);
  });

  it('rejects foreign payloads', () => {
    expect(() => decodeFrame(new Uint8Array(16))).toThrow();
  });
});

describe('land mask and demo scenarios', () => {
  const mask = buildLandMask(12, 41.5, 21, 46.5, 0.02);
  it('knows land from sea', () => {
    expect(isLandAt(mask, 16.0, 45.8)).toBe(true); // Zagreb
    expect(isLandAt(mask, 15.0, 43.0)).toBe(false); // open Adriatic
    expect(isLandAt(mask, 16.6, 43.3)).toBe(true); // Brač
  });

  it('demo bura classifies as bura with a strong gust near the Velebit gaps', () => {
    const b = makeDemoBundle('bura', NOW, mask);
    const f = buildFrame(b, Math.floor(NOW / 3600) * 3600 + 6 * 3600, NOW)!;
    expect(f.summary.regime).toBe('bura');
    expect(f.summary.gust.value).toBeGreaterThan(30);
  });

  it('demo jugo classifies as jugo', () => {
    const b = makeDemoBundle('jugo', NOW, mask);
    const f = buildFrame(b, Math.floor(NOW / 3600) * 3600 + 12 * 3600, NOW)!;
    expect(f.summary.regime).toBe('jugo');
  });
});
