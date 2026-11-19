import { describe, expect, it } from 'vitest';
import { type GridSpec, MODEL_GRID, cellCount, distanceKm, modelSampleMask, nodeLat, nodeLon } from '../shared/grid';
import { DEFAULT_CORRECTION, applyResiduals, bilinear, fillFromLattice, idw, resample } from '../shared/interp';

const G: GridSpec = { lon0: 14, lat0: 43, dlon: 0.5, dlat: 0.5, nx: 5, ny: 4 };
const fill = (g: GridSpec, f: (lon: number, lat: number) => number) => {
  const a = new Float32Array(cellCount(g));
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) a[j * g.nx + i] = f(nodeLon(g, i), nodeLat(g, j));
  return a;
};

describe('bilinear', () => {
  it('returns node values exactly at nodes', () => {
    const data = fill(G, (lon, lat) => lon * 10 + lat);
    expect(bilinear(G, data, 14.5, 43.5)).toBeCloseTo(14.5 * 10 + 43.5, 4);
    expect(bilinear(G, data, 16, 44.5)).toBeCloseTo(160 + 44.5, 4); // far corner
  });

  it('reproduces any bilinear (in particular linear) function between nodes', () => {
    const f = (lon: number, lat: number) => 3 * lon - 2 * lat + 0.5 * lon * lat + 7;
    const data = fill(G, f);
    for (const [lon, lat] of [[14.13, 43.21], [15.77, 44.02], [15.25, 43.5]]) {
      expect(bilinear(G, data, lon, lat)).toBeCloseTo(f(lon, lat), 3);
    }
  });

  it('clamps outside the grid to the nearest edge value', () => {
    const data = fill(G, (lon) => lon);
    expect(bilinear(G, data, 10, 43.7)).toBeCloseTo(14, 5);
    expect(bilinear(G, data, 99, 43.7)).toBeCloseTo(16, 5);
  });
});

describe('resample', () => {
  it('upsamples a linear field without error', () => {
    const f = (lon: number, lat: number) => 2 * lon + lat;
    const fine: GridSpec = { lon0: 14, lat0: 43, dlon: 0.1, dlat: 0.1, nx: 21, ny: 16 };
    const out = resample(G, fill(G, f), fine);
    const expected = fill(fine, f);
    for (let k = 0; k < out.length; k++) expect(out[k]).toBeCloseTo(expected[k], 3);
  });
});

describe('fillFromLattice', () => {
  it('fills unsampled ring nodes linearly from the 0.5° lattice', () => {
    const f = (lon: number, lat: number) => lon - 2 * lat;
    const truth = fill(MODEL_GRID, f);
    const mask = modelSampleMask();
    const holes = truth.map((x, k) => (mask[k] ? x : NaN));
    const out = fillFromLattice(MODEL_GRID, Float32Array.from(holes), mask);
    for (let k = 0; k < out.length; k++) expect(out[k]).toBeCloseTo(truth[k], 3);
  });

  it('samples ~540 locations (under the 600/min fair-use limit)', () => {
    const n = modelSampleMask().reduce((s, x) => s + x, 0);
    expect(n).toBe(542);
  });
});

describe('idw', () => {
  const pts = [
    { lon: 14.9, lat: 45.0, value: 20 },
    { lon: 16.4, lat: 43.5, value: 10 },
    { lon: 18.1, lat: 42.6, value: 0 },
  ];

  it('is exact at data points', () => {
    for (const p of pts) expect(idw(pts, p.lon, p.lat)).toBe(p.value);
  });

  it('stays within the data range (convex combination)', () => {
    for (let lon = 13; lon <= 19; lon += 0.37)
      for (let lat = 42; lat <= 46; lat += 0.29) {
        const v = idw(pts, lon, lat);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(20);
      }
  });

  it('is pulled toward the nearer point', () => {
    expect(idw(pts, 15.0, 44.9)).toBeGreaterThan(15);
  });

  it('returns NaN outside every radius', () => {
    expect(idw(pts, 13, 46, 2, 10)).toBeNaN();
  });
});

describe('applyResiduals (IDW correction)', () => {
  const g: GridSpec = { lon0: 13, lat0: 42, dlon: 0.1, dlat: 0.1, nx: 66, ny: 41 };
  const zeros = () => new Float32Array(cellCount(g));
  const station = { lon: 15.0, lat: 44.0, du: 6, dv: -3 };

  it('matches the observation at a station that sits on a node', () => {
    const { u, v } = applyResiduals(g, zeros(), zeros(), [station]);
    expect(bilinear(g, u, 15, 44)).toBeCloseTo(6, 4);
    expect(bilinear(g, v, 15, 44)).toBeCloseTo(-3, 4);
  });

  it('decays monotonically with distance and vanishes beyond the radius', () => {
    const { u } = applyResiduals(g, zeros(), zeros(), [station]);
    let prev = Infinity;
    for (let dLon = 0.1; dLon <= 1.0; dLon += 0.1) {
      const val = bilinear(g, u, 15 + dLon, 44);
      expect(val).toBeLessThanOrEqual(prev + 1e-6);
      prev = val;
    }
    const far = 15 + (DEFAULT_CORRECTION.radiusKm + 5) / distanceKm(15, 44, 16, 44);
    expect(bilinear(g, u, far, 44)).toBeCloseTo(0, 6);
  });

  it('leaves the model untouched with no stations, or with strength 0', () => {
    const base = Float32Array.from({ length: cellCount(g) }, (_, k) => Math.sin(k));
    expect(applyResiduals(g, base, base, []).u).toEqual(base);
    expect(applyResiduals(g, base, base, [station], { ...DEFAULT_CORRECTION, strength: 0 }).u).toEqual(base);
  });

  it('blends two nearby stations with a value between them', () => {
    const a = { lon: 15.0, lat: 44.0, du: 10, dv: 0 };
    const b = { lon: 15.2, lat: 44.0, du: 2, dv: 0 };
    const { u } = applyResiduals(g, zeros(), zeros(), [a, b]);
    const mid = bilinear(g, u, 15.1, 44.0);
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(10);
  });

  it('corrects u and v separately: opposite residuals cancel instead of rotating', () => {
    const a = { lon: 15.0, lat: 44.0, du: 5, dv: 0 };
    const b = { lon: 15.2, lat: 44.0, du: -5, dv: 0 };
    const { u, v } = applyResiduals(g, zeros(), zeros(), [a, b]);
    expect(bilinear(g, u, 15.1, 44.0)).toBeCloseTo(0, 4);
    expect(bilinear(g, v, 15.1, 44.0)).toBeCloseTo(0, 4);
  });
});
