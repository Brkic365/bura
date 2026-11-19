import './styles.css';
import { drawBasemap, drawOverlay } from './basemap';
import { rampColor, rampGradient } from './colors';
import { type Source, demoSource, liveSource } from './data';
import { ParticleField } from './gl/particles';
import { View } from './view';
import type { DemoScenario } from '../shared/demo';
import { DOMAIN, distanceKm } from '../shared/grid';
import { bilinear } from '../shared/interp';
import { buildLandMask } from '../shared/landmask';
import { REGIME_LABEL } from '../shared/regime';
import { TZ } from '../shared/time';
import type { FieldIndex, Frame, FrameStation } from '../shared/types';
import { beaufort, compass, fromUV } from '../shared/wind';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  app: $('app'),
  basemap: $<HTMLCanvasElement>('basemap'),
  particles: $<HTMLCanvasElement>('particles'),
  overlay: $<HTMLCanvasElement>('overlay'),
  mode: $('mode'),
  regime: $('regime'),
  detail: $('detail'),
  stations: $<HTMLButtonElement>('btn-stations'),
  reset: $<HTMLButtonElement>('btn-reset'),
  about: $<HTMLButtonElement>('btn-about'),
  dialog: $<HTMLDialogElement>('about'),
  play: $<HTMLButtonElement>('play'),
  live: $<HTMLButtonElement>('live'),
  scrub: $<HTMLInputElement>('scrub'),
  spark: $<HTMLCanvasElement>('spark'),
  timeLabel: $('time-label'),
  timeKind: $('time-kind'),
  tooltip: $('tooltip'),
  legend: $('legend-bar'),
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(innerWidth, innerHeight) < 600;
const PARTICLE_TIERS = [65536, 32768, 16384, 8192, 4096];
const PLAY_HOURS_PER_S = 2.5;

const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtHour = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });

class App {
  view = new View();
  dpr = Math.min(devicePixelRatio || 1, 2);
  /** Particle canvas resolution. 1-px GL lines vanish at 2×+, and 1.5× is visibly as sharp at half the fill cost. */
  glDpr = Math.min(devicePixelRatio || 1, 1.5);
  gl: ParticleField | null = null;
  source!: Source;
  index: FieldIndex | null = null;
  /** Fractional position in index.frames (hours from the first frame). */
  tf = 0;
  following = true;
  playing = false;
  showStations = true;
  pair: [Frame, Frame] | null = null;
  pairKey = '';
  loadingKey = '';
  hover: { lon: number; lat: number; x: number; y: number; sticky: boolean } | null = null;
  overlayDirty = true;
  tier = coarse || small ? 3 : 1;
  /** `?n=65536` pins the particle count and turns off adaptive quality (handy for screenshots). */
  pinned = Number(new URLSearchParams(location.search).get('n')) || 0;
  perf = { acc: 0, n: 0, since: 0, strikes: 0 };
  last = performance.now();

  async start() {
    el.legend.style.background = rampGradient();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(el.app);
    this.bindUi();
    // Data first, so the header text is filled in quickly. GL setup (shader linking,
    // land-mask raster) waits for an idle moment after first paint.
    const data = this.connect();
    await new Promise<void>((r) => ('requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout: 400 }) : setTimeout(r, 50)));
    await this.initGl();
    await data;
    if (!new URLSearchParams(location.search).has('capture')) requestAnimationFrame((t) => this.loop(t));
    setInterval(() => this.refresh(), 10 * 60_000);
  }

  async initGl() {
    try {
      const gl = new ParticleField(el.particles, {
        count: this.pinned || (reducedMotion ? PARTICLE_TIERS[this.tier + 1] : PARTICLE_TIERS[this.tier]),
        pxPerMs: reducedMotion ? 2.2 : 5.2,
        fade: reducedMotion ? 0.9 : 0.96,
        alpha: 1,
      });
      await gl.ready;
      if (gl.software && !this.pinned) {
        // CPU-emulated WebGL (SwiftShader, llvmpipe): keep it light so the page stays responsive.
        this.tier = PARTICLE_TIERS.length - 1;
        gl.setCount(PARTICLE_TIERS[this.tier]);
        this.frameInterval = 1 / 24;
        this.glDpr = 1;
      }
      const mask = buildLandMask(DOMAIN.lonMin, DOMAIN.latMin, DOMAIN.lonMax, DOMAIN.latMax, 0.02);
      gl.setLandMask(mask.data, mask.w, mask.h);
      this.gl = gl;
      this.resize();
      this.pairKey = ''; // re-upload the current frames into the new context
      el.particles.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.gl = null;
        el.detail.textContent = 'The graphics context was lost. Reload to restart the animation.';
      });
    } catch (err) {
      console.warn('[bura] WebGL2 unavailable, falling back to station markers', err);
      this.gl = null;
      this.overlayDirty = true;
    }
  }

  async connect() {
    const params = new URLSearchParams(location.search);
    const demo = params.get('demo') as DemoScenario | null;
    if (demo && (['bura', 'jugo', 'maestral'] as string[]).includes(demo)) {
      await this.useDemo(demo, 'Demo');
      return;
    }
    try {
      const live = liveSource();
      this.index = await live.index();
      this.source = live;
      el.app.classList.toggle('demo', !!this.index.demo);
      el.mode.textContent = this.index.demo ? `Seeded demo · ${this.index.demo}` : 'Live · DHMZ + Open-Meteo';
    } catch (err) {
      console.warn('[bura] live data unavailable, showing the demo', err);
      await this.useDemo('bura', 'Offline demo');
      return;
    }
    this.afterIndex();
  }

  async useDemo(s: DemoScenario, label: string) {
    this.source = await demoSource(s);
    this.index = await this.source.index();
    el.app.classList.add('demo');
    el.mode.textContent = `${label} · ${REGIME_LABEL[s].name}`;
    el.mode.title = label === 'Offline demo' ? 'The live data feed could not be reached, so a synthetic bura scenario is shown.' : 'Synthetic scenario, not real data.';
    this.afterIndex();
  }

  afterIndex() {
    const idx = this.index!;
    el.scrub.max = String(idx.frames.length - 1);
    el.scrub.disabled = false;
    if (this.following) this.tf = this.nowPosition();
    this.drawSpark();
    this.updateHud();
  }

  async refresh() {
    if (this.source?.kind !== 'live') return;
    try {
      const prevT = this.index?.frames[0]?.t;
      this.index = await this.source.index();
      if (!this.following && prevT !== undefined) {
        // Keep the same absolute time under the cursor.
        this.tf -= (this.index.frames[0].t - prevT) / 3600;
      }
      this.pairKey = '';
      this.afterIndex();
    } catch {
      /* keep showing what we have */
    }
  }

  nowPosition(): number {
    const idx = this.index!;
    const now = Date.now() / 1000;
    const pos = (now - idx.frames[0].t) / 3600;
    return Math.max(0, Math.min(idx.frames.length - 1, pos));
  }

  // ── Frames ────────────────────────────────────────────
  ensureFrames() {
    const idx = this.index;
    if (!idx) return;
    const n = idx.frames.length;
    const i0 = Math.max(0, Math.min(n - 1, Math.floor(this.tf)));
    const i1 = Math.min(n - 1, i0 + 1);
    const key = `${idx.frames[i0].t}:${idx.frames[i1].t}:${idx.updatedAt}`;
    if (this.gl && this.pair) this.gl.mix = Math.max(0, Math.min(1, this.tf - i0));
    if (key === this.pairKey || key === this.loadingKey) return;
    this.loadingKey = key;
    Promise.all([this.source.frame(idx.frames[i0].t), this.source.frame(idx.frames[i1].t)])
      .then(([a, b]) => {
        if (this.loadingKey !== key) return;
        this.pair = [a, b];
        this.pairKey = key;
        this.loadingKey = '';
        this.gl?.setFields(a.grid, a, b);
        if (this.gl) this.gl.mix = Math.max(0, Math.min(1, this.tf - i0));
        this.overlayDirty = true;
        this.updateHud();
        // Prefetch ahead, in the direction of play.
        for (const k of [i1 + 1, i1 + 2]) if (k < n) this.source.frame(idx.frames[k].t).catch(() => {});
      })
      .catch((err) => {
        console.warn('[bura] frame load failed', err);
        this.loadingKey = '';
      });
  }

  /** Station reports to show: this hour's, or failing that the latest within 3 h before it. */
  stationsNow(): { stations: FrameStation[]; t: number | null } {
    if (!this.pair) return { stations: [], t: null };
    const [a] = this.pair;
    if (a.stations.length) return { stations: a.stations, t: a.t };
    return { stations: [], t: null };
  }

  // ── Render loop ───────────────────────────────────────
  /** Minimum seconds between rendered frames (0 = every display frame). */
  frameInterval = 0;
  throttled = false;

  loop(now: number) {
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.1, raw);
    if (dt >= this.frameInterval) {
      this.last = now;
      // Background or throttled tabs deliver frames seconds apart: render them, but don't
      // let them count as GPU slowness.
      this.throttled = raw > 0.1 || document.visibilityState !== 'visible';
      this.tick(dt);
    }
    requestAnimationFrame((t) => this.loop(t));
  }

  /**
   * Deterministic stepping for recordings (`?capture`): the page stops animating on its own and a
   * script calls `bura.advance(1, 1/30)`, then screenshots, frame by frame.
   */
  async advance(frames: number, dt: number) {
    for (let i = 0; i < frames; i++) {
      this.tick(dt);
      for (let k = 0; k < 50 && this.loadingKey; k++) await new Promise((r) => setTimeout(r, 0));
    }
    this.gl?.gl.finish();
  }

  tick(dt: number) {
    if (this.index) {
      if (this.playing) {
        this.tf += dt * PLAY_HOURS_PER_S;
        if (this.tf >= this.index.frames.length - 1) {
          this.tf = this.index.frames.length - 1;
          this.setPlaying(false);
        }
        this.updateHud();
      } else if (this.following) {
        const p = this.nowPosition();
        if (Math.abs(p - this.tf) > 1 / 120) {
          this.tf = p;
          this.updateHud();
        }
      }
      this.ensureFrames();
    }
    if (this.gl) {
      this.gl.frame(this.view.domainRect(), this.view.degPerPx(), dt);
      this.adapt(dt);
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      const { stations } = this.stationsNow();
      const s = this.currentSummary();
      drawOverlay(el.overlay, this.view, this.dpr, {
        showStations: this.showStations || !this.gl,
        stations,
        hover: this.hover,
        gust: s && s.regime !== 'calm' ? { lon: s.gust.lon, lat: s.gust.lat } : null,
      });
    }
  }

  /** Drop to a lighter particle tier if the GPU can't hold ~45 fps. */
  adapt(dt: number) {
    if (this.pinned || this.throttled || this.frameInterval) return;
    const p = this.perf;
    p.since += dt;
    if (p.since < 2) return; // warm-up
    p.acc += dt;
    p.n++;
    if (p.n >= 90) {
      const avg = p.acc / p.n;
      p.acc = 0;
      p.n = 0;
      // Two slow windows in a row before stepping down, so one hitch doesn't cost quality.
      p.strikes = avg > 1 / 40 ? p.strikes + 1 : 0;
      if (p.strikes >= 2 && this.tier < PARTICLE_TIERS.length - 1) {
        p.strikes = 0;
        this.tier++;
        this.gl!.setCount(PARTICLE_TIERS[this.tier]);
        console.info(`[bura] frame time ${(avg * 1000).toFixed(1)} ms → ${PARTICLE_TIERS[this.tier]} particles`);
      }
    }
  }

  resize() {
    const r = el.app.getBoundingClientRect();
    this.view.resize(r.width, r.height);
    const w = Math.round(r.width * this.glDpr);
    const h = Math.round(r.height * this.glDpr);
    el.particles.width = w;
    el.particles.height = h;
    this.gl?.resize(w, h);
    drawBasemap(el.basemap, this.view, this.dpr);
    this.overlayDirty = true;
    this.drawSpark();
  }

  viewChanged() {
    drawBasemap(el.basemap, this.view, this.dpr);
    this.gl?.clearTrails();
    this.overlayDirty = true;
    el.reset.hidden = this.view.isFit();
    if (this.hover) this.updateTooltip();
  }

  // ── HUD ───────────────────────────────────────────────
  currentFrameInfo() {
    const idx = this.index;
    if (!idx) return null;
    // The hour that has started (not the nearest one), so "now" reads as observed, not +1 h.
    const i = Math.max(0, Math.min(idx.frames.length - 1, Math.floor(this.tf + 1e-6)));
    return idx.frames[i];
  }
  currentSummary() {
    return this.currentFrameInfo()?.summary ?? null;
  }

  updateHud() {
    const f = this.currentFrameInfo();
    if (!f || !this.index) return;
    const s = f.summary;
    const label = REGIME_LABEL[s.regime];
    if (el.regime.textContent !== label.name) {
      el.regime.textContent = label.name;
      el.regime.classList.toggle('long', label.name.length > 8);
    }
    const gust = `gusts to <b>${Math.round(s.gust.value)} m/s</b> near ${s.gust.name}`;
    const detail =
      s.regime === 'calm'
        ? `Light winds along the coast · ${gust}`
        : s.regime === 'variable'
          ? `No dominant direction · mean <b>${s.meanSpeed} m/s</b> · ${gust}`
          : `<b>${compass(s.fromDeg)}</b> · ${label.gloss} · mean <b>${s.meanSpeed} m/s</b> · ${gust}`;
    if (el.detail.innerHTML !== detail) el.detail.innerHTML = detail;

    const exactT = this.index.frames[0].t + this.tf * 3600;
    el.timeLabel.textContent = fmtTime.format(new Date((this.following ? Date.now() / 1000 : exactT) * 1000));
    const lead = Math.round((f.t - this.index.nowT) / 3600);
    el.timeKind.textContent = f.kind === 'obs' ? 'Observed + model' : f.kind === 'forecast' ? `Forecast +${lead} h` : 'Model';
    el.timeKind.className = `kind ${f.kind}`;
    const pos = String(Math.floor(this.tf + 1e-6));
    if (el.scrub.value !== pos) el.scrub.value = pos;
    el.scrub.setAttribute('aria-valuetext', `${el.timeLabel.textContent}, ${el.timeKind.textContent}, ${label.name}`);
    el.live.hidden = this.following;
    el.overlay.setAttribute('aria-label', `Wind map, ${label.name}: ${el.detail.textContent}`);
  }

  drawSpark() {
    const idx = this.index;
    const c = el.spark;
    const r = c.getBoundingClientRect();
    if (!r.width) return;
    c.width = Math.round(r.width * this.dpr);
    c.height = Math.round(r.height * this.dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    // Baseline
    ctx.fillStyle = 'rgba(160,210,230,0.16)';
    ctx.fillRect(0, r.height - 1, r.width, 1);
    if (!idx) return;
    const n = idx.frames.length;
    const x = (i: number) => (i / (n - 1)) * (r.width - 2) + 1;
    const maxG = Math.max(20, ...idx.frames.map((f) => f.summary.gust.value));
    const maxM = Math.max(6, ...idx.frames.map((f) => f.summary.meanSpeed)) * 1.15;
    const y = (v: number) => r.height - 2 - (v / maxG) * (r.height - 14);
    const yBar = (v: number) => r.height - 2 - (v / maxM) * (r.height - 18);

    // Mean coastal wind as coloured bars.
    const bw = Math.max(1, r.width / n - 1);
    idx.frames.forEach((f, i) => {
      ctx.fillStyle = rampColor(f.summary.meanSpeed * 1.4);
      ctx.globalAlpha = f.kind === 'forecast' ? 0.45 : 0.85;
      const top = yBar(f.summary.meanSpeed);
      ctx.fillRect(x(i) - bw / 2, top, bw, r.height - 1 - top);
    });
    ctx.globalAlpha = 1;
    // Max gust line.
    ctx.strokeStyle = 'rgba(233,247,252,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    idx.frames.forEach((f, i) => (i ? ctx.lineTo(x(i), y(f.summary.gust.value)) : ctx.moveTo(x(i), y(f.summary.gust.value))));
    ctx.stroke();

    // Midnight ticks with day names, and a "now" marker.
    ctx.font = `600 9.5px "Archivo Variable", system-ui`;
    ctx.textBaseline = 'top';
    idx.frames.forEach((f, i) => {
      if (fmtHour.format(new Date(f.t * 1000)) === '00') {
        ctx.fillStyle = 'rgba(160,210,230,0.28)';
        ctx.fillRect(x(i), 0, 1, r.height);
        ctx.fillStyle = 'rgba(222,240,247,0.5)';
        ctx.fillText(fmtDay.format(new Date(f.t * 1000)).toUpperCase(), x(i) + 4, 1);
      }
    });
    const nowI = (Date.now() / 1000 - idx.frames[0].t) / 3600;
    ctx.fillStyle = '#3fd0f0';
    ctx.fillRect(x(nowI) - 0.5, 0, 1.5, r.height);
    ctx.fillText('NOW', x(nowI) + 4, r.height - 12);
  }

  // ── Interaction ───────────────────────────────────────
  setPlaying(on: boolean) {
    this.playing = on;
    el.play.setAttribute('aria-pressed', String(on));
    el.play.setAttribute('aria-label', on ? 'Pause' : 'Play through time');
    if (on) {
      this.following = false;
      if (this.index && this.tf >= this.index.frames.length - 1.01) this.tf = 0;
    }
    this.updateHud();
  }

  sampleAt(lon: number, lat: number) {
    if (!this.pair) return null;
    const [a, b] = this.pair;
    const m = this.gl?.mix ?? 0;
    const s = (f: Frame, arr: Float32Array) => bilinear(f.grid, arr, lon, lat);
    const u = s(a, a.u) * (1 - m) + s(b, b.u) * m;
    const v = s(a, a.v) * (1 - m) + s(b, b.v) * m;
    const gust = s(a, a.gust) * (1 - m) + s(b, b.gust) * m;
    return { ...fromUV(u, v), gust };
  }

  updateTooltip() {
    const h = this.hover;
    const tip = el.tooltip;
    if (!h) {
      tip.hidden = true;
      return;
    }
    const inside = h.lon > DOMAIN.lonMin && h.lon < DOMAIN.lonMax && h.lat > DOMAIN.latMin && h.lat < DOMAIN.latMax;
    const w = inside ? this.sampleAt(h.lon, h.lat) : null;
    if (!w) {
      tip.hidden = true;
      return;
    }
    const { stations } = this.stationsNow();
    let near: { s: FrameStation; d: number } | null = null;
    for (const st of stations) {
      const d = distanceKm(h.lon, h.lat, st.lon, st.lat);
      if (!near || d < near.d) near = { s: st, d };
    }
    const arrow = `<span class="arrow" style="transform:rotate(${(w.fromDeg + 180) % 360}deg)">↑</span>`;
    let html = `<div class="row"><span><span class="big">${w.speed.toFixed(1)}</span><span class="unit">m/s</span></span><span>${arrow} ${compass(w.fromDeg)} ${Math.round(w.fromDeg)}°</span></div>
      <div class="row"><span>Gusts</span><span>${w.gust.toFixed(0)} m/s</span></div>
      <div class="row"><span>Beaufort</span><span>${beaufort(w.speed)}</span></div>`;
    if (near) {
      const st = near.s;
      const obs = st.fromDeg === null ? 'calm' : `${st.speed.toFixed(1)} m/s ${compass(st.fromDeg)}`;
      html += `<div class="sub"><div class="row"><span>${st.name}</span><span>${Math.round(near.d)} km</span></div><div class="row"><span>Observed</span><span>${obs}</span></div></div>`;
    } else {
      html += `<div class="sub">${h.lat.toFixed(2)}°N ${h.lon.toFixed(2)}°E · no station report this hour</div>`;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = h.x + 16;
    let y = h.y + 16;
    if (x + tw > this.view.w - 8) x = h.x - tw - 16;
    if (y + th > this.view.h - 120) y = h.y - th - 16;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }

  bindUi() {
    el.stations.addEventListener('click', () => {
      this.showStations = !this.showStations;
      el.stations.setAttribute('aria-pressed', String(this.showStations));
      this.overlayDirty = true;
    });
    el.reset.addEventListener('click', () => {
      this.view.reset();
      this.viewChanged();
    });
    el.about.addEventListener('click', () => el.dialog.showModal());
    el.dialog.addEventListener('click', (e) => {
      if (e.target === el.dialog) el.dialog.close();
    });
    el.play.addEventListener('click', () => this.setPlaying(!this.playing));
    el.live.addEventListener('click', () => {
      this.setPlaying(false);
      this.following = true;
      this.tf = this.nowPosition();
      this.updateHud();
    });
    el.scrub.addEventListener('input', () => {
      const value = Number(el.scrub.value); // read first: setPlaying() re-syncs the slider
      this.following = false;
      this.setPlaying(false);
      this.tf = value;
      this.updateHud();
      if (this.hover) this.updateTooltip();
    });
    addEventListener('keydown', (e) => {
      if (el.dialog.open || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 's' || e.key === 'S') el.stations.click();
      else if (e.key === ' ') {
        e.preventDefault();
        el.play.click();
      } else if (e.key === '0') el.reset.click();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        this.following = false;
        this.tf = Math.max(0, Math.min(Number(el.scrub.max), Math.round(this.tf) + (e.key === 'ArrowRight' ? 1 : -1)));
        this.updateHud();
      }
    });

    // Pan, zoom, hover, pinch.
    const ov = el.overlay;
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinchDist = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = ov.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const setHover = (x: number, y: number, sticky: boolean) => {
      const [lon, lat] = this.view.toLonLat(x, y);
      this.hover = { lon, lat, x, y, sticky };
      this.overlayDirty = true;
      this.updateTooltip();
    };
    ov.addEventListener('pointerdown', (e) => {
      ov.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      moved = 0;
      if (pointers.size === 2) {
        const [p, q] = [...pointers.values()];
        pinchDist = Math.hypot(p.x - q.x, p.y - q.y);
      }
    });
    ov.addEventListener('pointermove', (e) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === 'mouse') setHover(p.x, p.y, false);
        return;
      }
      if (pointers.size === 1) {
        moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
        if (moved > 4) {
          ov.classList.add('dragging');
          this.view.panBy(p.x - prev.x, p.y - prev.y);
          this.viewChanged();
        }
      } else if (pointers.size === 2) {
        pointers.set(e.pointerId, p);
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) {
          this.view.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
          this.viewChanged();
        }
        pinchDist = d;
        moved = 99;
      }
      pointers.set(e.pointerId, p);
      if (e.pointerType === 'mouse' && moved <= 4) setHover(p.x, p.y, false);
    });
    const end = (e: PointerEvent) => {
      const p = local(e);
      if (pointers.has(e.pointerId) && moved <= 4 && e.type === 'pointerup') {
        if (e.pointerType !== 'mouse') {
          if (this.hover?.sticky && Math.hypot(this.hover.x - p.x, this.hover.y - p.y) < 24) {
            this.hover = null;
            this.updateTooltip();
            this.overlayDirty = true;
          } else setHover(p.x, p.y, true);
        }
      }
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (!pointers.size) ov.classList.remove('dragging');
    };
    ov.addEventListener('pointerup', end);
    ov.addEventListener('pointercancel', end);
    ov.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !pointers.size) {
        this.hover = null;
        this.updateTooltip();
        this.overlayDirty = true;
      }
    });
    ov.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        this.view.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)));
        this.viewChanged();
      },
      { passive: false },
    );
    ov.addEventListener('dblclick', (e) => {
      const p = local(e as unknown as PointerEvent);
      this.view.zoomAt(p.x, p.y, 1.8);
      this.viewChanged();
    });
  }
}

const app = new App();
app.start().catch((err) => {
  console.error(err);
  el.detail.textContent = 'Something went wrong while loading the wind field.';
});
// Exposed for debugging in the console and for the screenshot script.
(window as unknown as { bura: App }).bura = app;
