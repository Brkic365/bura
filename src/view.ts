import { DOMAIN } from '../shared/grid';

const COS0 = Math.cos((44 * Math.PI) / 180);
const LON_SPAN = DOMAIN.lonMax - DOMAIN.lonMin;
const LAT_SPAN = DOMAIN.latMax - DOMAIN.latMin;

/** The Croatian coast, used for the initial fit. */
const FIT = { lonMin: 13.25, lonMax: 19.5, latMin: 42.25, latMax: 45.85 };

/**
 * Equirectangular view with the longitude scale fixed at 44°N. At this extent it is
 * indistinguishable from Mercator, and it keeps the field texture → screen mapping affine,
 * which the particle shaders rely on.
 */
export class View {
  w = 1;
  h = 1;
  cLon = 16.3;
  cLat = 44.05;
  /** CSS pixels per degree of latitude. */
  k = 100;
  private fitK = 100;

  resize(w: number, h: number) {
    const first = this.w === 1;
    const rel = this.k / this.fitK;
    this.w = w;
    this.h = h;
    const portrait = h > w * 1.1;
    // Screen space taken by the header (portrait only; on wide screens it sits over inland
    // Bosnia, top right) and by the timeline at the bottom.
    const top = portrait ? 200 : 36;
    const bottom = portrait ? 150 : 118;
    const lonSpan = (portrait ? 5.0 : FIT.lonMax - FIT.lonMin) * COS0;
    const latSpan = FIT.latMax - FIT.latMin;
    const usableH = Math.max(120, h - top - bottom);
    this.fitK = Math.max(20, Math.min((w * 0.96) / lonSpan, usableH / latSpan));
    if (first) {
      this.k = this.fitK;
      const midLat = (FIT.latMin + FIT.latMax) / 2;
      const targetY = top + usableH / 2;
      this.cLon = portrait ? 15.95 : (FIT.lonMin + FIT.lonMax) / 2;
      this.cLat = midLat - (h / 2 - targetY) / this.k;
    } else {
      this.k = this.fitK * rel;
    }
    this.clamp();
  }

  /** Back to the initial framing of the whole coast. */
  reset() {
    const { w, h } = this;
    this.w = 1;
    this.resize(w, h);
  }

  toScreen(lon: number, lat: number): [number, number] {
    return [this.w / 2 + (lon - this.cLon) * this.k * COS0, this.h / 2 - (lat - this.cLat) * this.k];
  }

  toLonLat(x: number, y: number): [number, number] {
    return [this.cLon + (x - this.w / 2) / (this.k * COS0), this.cLat - (y - this.h / 2) / this.k];
  }

  /** Visible rectangle in normalised domain coordinates (0..1 over DOMAIN): [x0, y0, x1, y1]. */
  domainRect(): [number, number, number, number] {
    const [lon0, lat1] = this.toLonLat(0, 0);
    const [lon1, lat0] = this.toLonLat(this.w, this.h);
    return [(lon0 - DOMAIN.lonMin) / LON_SPAN, (lat0 - DOMAIN.latMin) / LAT_SPAN, (lon1 - DOMAIN.lonMin) / LON_SPAN, (lat1 - DOMAIN.latMin) / LAT_SPAN];
  }

  /** Degrees of latitude per CSS pixel; the shaders use it for screen-constant particle speed. */
  degPerPx() {
    return 1 / this.k;
  }

  zoomAt(x: number, y: number, factor: number) {
    const [lon, lat] = this.toLonLat(x, y);
    this.k = Math.min(this.fitK * 7, Math.max(this.fitK * 0.75, this.k * factor));
    // Keep the point under the cursor fixed.
    this.cLon = lon - (x - this.w / 2) / (this.k * COS0);
    this.cLat = lat + (y - this.h / 2) / this.k;
    this.clamp();
  }

  panBy(dx: number, dy: number) {
    this.cLon -= dx / (this.k * COS0);
    this.cLat += dy / this.k;
    this.clamp();
  }

  private clamp() {
    this.cLon = Math.min(DOMAIN.lonMax - 0.5, Math.max(DOMAIN.lonMin + 0.5, this.cLon));
    this.cLat = Math.min(DOMAIN.latMax - 0.3, Math.max(DOMAIN.latMin + 0.3, this.cLat));
  }

  isFit() {
    return Math.abs(this.k / this.fitK - 1) < 0.01;
  }
}
