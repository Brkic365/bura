import { rampColor } from './colors';
import type { View } from './view';
import { coastBox, coastGeometry } from '../shared/landmask';
import { PLACES } from '../shared/places';
import type { FrameStation } from '../shared/types';
import { toUV } from '../shared/wind';

const FONT = '"Archivo Variable", "Archivo", system-ui, sans-serif';

function prep(canvas: HTMLCanvasElement, view: View, dpr: number) {
  const w = Math.round(view.w * dpr);
  const h = Math.round(view.h * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  return ctx;
}

/** Static layer under the particles: background, land, coastline, borders. Redrawn only when the view changes. */
export function drawBasemap(canvas: HTMLCanvasElement, view: View, dpr: number) {
  const ctx = prep(canvas, view, dpr);
  const { land, borders } = coastGeometry();

  const bg = ctx.createRadialGradient(view.w * 0.42, view.h * 0.5, 0, view.w * 0.5, view.h * 0.5, Math.max(view.w, view.h) * 0.75);
  bg.addColorStop(0, '#081219');
  bg.addColorStop(1, '#040609');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, view.w, view.h);

  const path = new Path2D();
  for (const ring of land) {
    ring.forEach(([lon, lat], i) => {
      const [x, y] = view.toScreen(lon, lat);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
  }
  ctx.fillStyle = '#0a0f14';
  ctx.fill(path, 'evenodd');

  // Stroke the real coastline only, not the edges added by clipping to the data box.
  const box = coastBox();
  const onEdge = (lon: number, lat: number) =>
    Math.abs(lon - box.minX) < 1e-6 || Math.abs(lon - box.maxX) < 1e-6 || Math.abs(lat - box.minY) < 1e-6 || Math.abs(lat - box.maxY) < 1e-6;
  const coastPath = new Path2D();
  for (const ring of land) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (onEdge(a[0], a[1]) && onEdge(b[0], b[1])) continue;
      const [x1, y1] = view.toScreen(a[0], a[1]);
      const [x2, y2] = view.toScreen(b[0], b[1]);
      coastPath.moveTo(x1, y1);
      coastPath.lineTo(x2, y2);
    }
  }
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(140, 200, 222, 0.30)';
  ctx.lineWidth = 0.8;
  ctx.stroke(coastPath);

  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = 'rgba(150, 175, 195, 0.13)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (const line of borders) {
    line.forEach(([lon, lat], i) => {
      const [x, y] = view.toScreen(lon, lat);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

export interface OverlayState {
  showStations: boolean;
  stations: FrameStation[];
  hover: { lon: number; lat: number } | null;
  gust: { lon: number; lat: number } | null;
}

/** Top layer: place labels, station markers, the gust marker and the hover crosshair. */
export function drawOverlay(canvas: HTMLCanvasElement, view: View, dpr: number, s: OverlayState) {
  const ctx = prep(canvas, view, dpr);
  const zoomed = view.k > 280;

  ctx.font = `500 10.5px ${FONT}`;
  ctx.textBaseline = 'middle';
  for (const p of PLACES) {
    if (!p.label && !zoomed) continue;
    const [x, y] = view.toScreen(p.lon, p.lat);
    if (x < -50 || y < -20 || x > view.w + 50 || y > view.h + 20) continue;
    ctx.fillStyle = 'rgba(220, 236, 244, 0.55)';
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = p.label ? 'rgba(220, 236, 244, 0.72)' : 'rgba(220, 236, 244, 0.5)';
    ctx.fillText(p.name.toUpperCase(), x + 6, y, 140);
    ctx.shadowBlur = 0;
  }

  if (s.showStations) {
    for (const st of s.stations) {
      const [x, y] = view.toScreen(st.lon, st.lat);
      if (x < -10 || y < -10 || x > view.w + 10 || y > view.h + 10) continue;
      const col = rampColor(st.speed);
      if (st.fromDeg !== null) {
        const [u, v] = toUV(st.fromDeg, 1);
        const len = 9 + Math.min(st.speed, 30) * 0.9;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        const ex = x + u * len;
        const ey = y - v * len;
        ctx.lineTo(ex, ey);
        // arrow head
        const a = Math.atan2(-v, u);
        ctx.lineTo(ex - Math.cos(a - 0.5) * 4, ey - Math.sin(a - 0.5) * 4);
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(a + 0.5) * 4, ey - Math.sin(a + 0.5) * 4);
        ctx.stroke();
      }
      ctx.fillStyle = st.fromDeg === null ? 'rgba(4,6,9,0.9)' : col;
      ctx.strokeStyle = 'rgba(4, 6, 9, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (st.fromDeg === null) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  if (s.gust) {
    const [x, y] = view.toScreen(s.gust.lon, s.gust.lat);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (s.hover) {
    const [x, y] = view.toScreen(s.hover.lon, s.hover.lat);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 9, y);
    ctx.lineTo(x - 3, y);
    ctx.moveTo(x + 3, y);
    ctx.lineTo(x + 9, y);
    ctx.moveTo(x, y - 9);
    ctx.lineTo(x, y - 3);
    ctx.moveTo(x, y + 3);
    ctx.lineTo(x, y + 9);
    ctx.stroke();
  }
}
