/**
 * Builds the compact basemap asset (shared/data/coast.json) from Natural Earth 10m GeoJSON.
 *
 *   npx tsx scripts/build-coastline.ts <dir-with-natural-earth-geojson>
 *
 * Expects ne_10m_land.geojson, ne_10m_minor_islands.geojson and
 * ne_10m_admin_0_boundary_lines_land.geojson in that directory
 * (https://github.com/nvkelso/natural-earth-vector/tree/master/geojson).
 *
 * Steps: clip to the view box -> Douglas-Peucker simplify -> drop specks ->
 * quantise to 1/1000 degree -> delta-encode. Output is a few tens of kB.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Pt = [number, number];
const BOX = { minX: 11, maxX: 22, minY: 40.5, maxY: 47.5 };
const TOL = 0.0022; // degrees (~220 m)
const MIN_AREA = 1.5e-5; // deg², ~0.15 km²
const Q = 1000; // quantisation: 1/1000 degree

const dir = process.argv[2];
if (!dir) {
  console.error('usage: build-coastline.ts <natural-earth-geojson-dir>');
  process.exit(1);
}

function readGeo(name: string) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
    features: { geometry: { type: string; coordinates: any } }[];
  };
}

// Sutherland–Hodgman against one axis-aligned edge at a time.
function clipRing(ring: Pt[]): Pt[] {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= BOX.minX, (a, b) => lerpX(a, b, BOX.minX)],
    [(p) => p[0] <= BOX.maxX, (a, b) => lerpX(a, b, BOX.maxX)],
    [(p) => p[1] >= BOX.minY, (a, b) => lerpY(a, b, BOX.minY)],
    [(p) => p[1] <= BOX.maxY, (a, b) => lerpY(a, b, BOX.maxY)],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cut(prev, cur));
      }
    }
    if (out.length === 0) break;
  }
  return out;
}
const lerpX = (a: Pt, b: Pt, x: number): Pt => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
const lerpY = (a: Pt, b: Pt, y: number): Pt => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];

function clipLine(line: Pt[]): Pt[][] {
  const inBox = (p: Pt) => p[0] >= BOX.minX && p[0] <= BOX.maxX && p[1] >= BOX.minY && p[1] <= BOX.maxY;
  const parts: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of line) {
    if (inBox(p)) cur.push(p);
    else if (cur.length) {
      parts.push(cur);
      cur = [];
    }
  }
  if (cur.length) parts.push(cur);
  return parts.filter((p) => p.length > 1);
}

function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function area(r: Pt[]) {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
function encode(pts: Pt[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of pts) {
    const qx = Math.round(x * Q);
    const qy = Math.round(y * Q);
    if (out.length && qx === px && qy === py) continue;
    out.push(qx - px, qy - py);
    px = qx;
    py = qy;
  }
  return out;
}

const land: number[][] = [];
let pointCount = 0;
for (const file of ['ne_10m_land.geojson', 'ne_10m_minor_islands.geojson']) {
  for (const f of readGeo(file).features) {
    const g = f.geometry;
    const polys: Pt[][][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      for (const ring of poly) {
        const clipped = clipRing(ring as Pt[]);
        if (clipped.length < 4) continue;
        const s = simplify([...clipped, clipped[0]], TOL).slice(0, -1);
        if (s.length < 3 || area(s) < MIN_AREA) continue;
        land.push(encode(s));
        pointCount += s.length;
      }
    }
  }
}

const borders: number[][] = [];
for (const f of readGeo('ne_10m_admin_0_boundary_lines_land.geojson').features) {
  const g = f.geometry;
  const lines: Pt[][] = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  for (const line of lines) {
    for (const part of clipLine(line)) {
      const s = simplify(part, TOL * 2);
      borders.push(encode(s));
      pointCount += s.length;
    }
  }
}

const out = {
  note: 'Made with Natural Earth (public domain). Rings/lines are delta-encoded [dx,dy,...] in 1/1000 degree.',
  q: Q,
  box: BOX,
  land,
  borders,
};
writeFileSync(new URL('../shared/data/coast.json', import.meta.url), JSON.stringify(out));
console.log(`rings=${land.length} borders=${borders.length} points=${pointCount}`);
