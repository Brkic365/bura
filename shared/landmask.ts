import coast from './data/coast.json';

export type Ring = [number, number][];

function decode(arr: number[], q: number): Ring {
  const pts: Ring = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < arr.length; i += 2) {
    x += arr[i];
    y += arr[i + 1];
    pts.push([x / q, y / q]);
  }
  return pts;
}

let decoded: { land: Ring[]; borders: Ring[] } | null = null;
/** Natural Earth land rings and border lines, decoded to [lon, lat] arrays. */
export function coastGeometry() {
  if (!decoded) decoded = { land: coast.land.map((r) => decode(r, coast.q)), borders: coast.borders.map((r) => decode(r, coast.q)) };
  return decoded;
}

/** The clip box the coastline asset was cut to. */
export const coastBox = () => coast.box;

export interface LandMask {
  lon0: number;
  lat0: number;
  res: number;
  w: number;
  h: number;
  /** 255 = land, 0 = sea. Row 0 is the SOUTH edge. */
  data: Uint8Array;
}

/**
 * Rasterise the land polygons with an even-odd scanline fill. Each row costs O(edges), so a
 * 900×500 mask at 0.01° takes a few ms. The client uses the mask to dim particles over land, and
 * the demo generator uses it to make synthetic wind feel the coastline.
 */
export function buildLandMask(lon0: number, lat0: number, lon1: number, lat1: number, res: number): LandMask {
  const w = Math.round((lon1 - lon0) / res);
  const h = Math.round((lat1 - lat0) / res);
  const data = new Uint8Array(w * h);
  const edges: [number, number, number, number][] = [];
  for (const ring of coastGeometry().land) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
  }
  const xs: number[] = [];
  for (let j = 0; j < h; j++) {
    const lat = lat0 + (j + 0.5) * res;
    xs.length = 0;
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= lat && y2 > lat) || (y2 <= lat && y1 > lat)) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - lon0) / res - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[k + 1] - lon0) / res - 0.5));
      for (let i = i0; i <= i1; i++) data[j * w + i] = 255;
    }
  }
  return { lon0, lat0, res, w, h, data };
}

export function isLandAt(m: LandMask, lon: number, lat: number): boolean {
  const i = Math.floor((lon - m.lon0) / m.res);
  const j = Math.floor((lat - m.lat0) / m.res);
  if (i < 0 || j < 0 || i >= m.w || j >= m.h) return false;
  return m.data[j * m.w + i] > 127;
}
