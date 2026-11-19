/**
 * GPU particle advection (WebGL2).
 *
 * Particle positions live in a W×H RGBA8 texture, two bytes per axis, which gives 1/65025 of the
 * domain (~10 m) of precision. Each frame:
 *
 *   1. UPDATE  (ping-pong: stateA → stateB). A fragment shader reads a position, samples the wind
 *              field (two RG16F textures, linearly interpolated in space and in time between hourly
 *              frames), steps the particle forward, and randomly respawns a few so the coverage stays
 *              even and fast regions don't empty out.
 *   2. FADE    (ping-pong: trailA → trailB). The previous trail image is redrawn at ~95 % strength.
 *              Floor-quantised so trails fade fully to zero instead of leaving 1/255 ghosts.
 *   3. DRAW    One line segment per particle, old → new position, built in the vertex shader from
 *              gl_VertexID (no vertex buffers). Colour comes from the speed ramp. Segments are dimmed
 *              over land (land-mask texture) and near the domain edge.
 *   4. BLIT    The trail texture goes to the canvas (premultiplied alpha) over the 2D basemap.
 *
 * Everything stays on the GPU. Per frame the CPU only sets a few uniforms.
 */
import { rampGlsl } from '../colors';
import { DOMAIN, type GridSpec } from '../../shared/grid';

const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `
uniform sampler2D u_fieldA;
uniform sampler2D u_fieldB;
uniform float u_mix;
uniform vec2 u_grid; // nx, ny

vec2 decodePos(vec4 c) {
  return vec2(c.r / 255.0 + c.b, c.g / 255.0 + c.a);
}

vec2 wind(vec2 p) {
  vec2 uv = (p * (u_grid - 1.0) + 0.5) / u_grid; // texel centres sit on grid nodes
  return mix(texture(u_fieldA, uv).rg, texture(u_fieldB, uv).rg, u_mix);
}
`;

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform float u_seed;
uniform float u_step;      // degrees of latitude moved per (m/s), for this frame
uniform vec4 u_spawn;      // respawn rectangle in domain coords
uniform float u_drop;      // base respawn probability per frame
uniform float u_dropBump;  // extra respawn probability for fast particles
uniform vec2 u_span;       // lon span, lat span of the domain (degrees)
uniform float u_lat0;
in vec2 v_uv;
out vec4 o;
${COMMON}
const vec3 K = vec3(12.9898, 78.233, 4375.85453);
float rand(vec2 co) {
  float t = dot(K.xy, co);
  return fract(sin(t) * (K.z + t));
}
void main() {
  vec2 p = decodePos(texture(u_state, v_uv));
  vec2 vel = wind(p);
  float lat = u_lat0 + p.y * u_span.y;
  // Metres → degrees: one degree of longitude shrinks by cos(lat).
  vec2 d = vec2(vel.x / cos(radians(lat)), vel.y) * u_step / u_span;
  p += d;

  vec2 seed = (p + v_uv) * u_seed;
  float speed = length(vel);
  float dropRate = u_drop + clamp(speed / 25.0, 0.0, 1.0) * u_dropBump;
  bool outside = p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.x < u_spawn.x - 0.02 || p.x > u_spawn.z + 0.02 || p.y < u_spawn.y - 0.02 || p.y > u_spawn.w + 0.02;
  if (outside || rand(seed + 1.3) < dropRate) {
    p = u_spawn.xy + vec2(rand(seed + 2.1), rand(seed + 3.7)) * (u_spawn.zw - u_spawn.xy);
  }
  o = vec4(fract(p * 255.0), floor(p * 255.0) / 255.0);
}`;

const DRAW_VS = `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform sampler2D u_land;
uniform int u_stateW;
uniform vec4 u_view;
uniform float u_alpha;
${COMMON}
${rampGlsl()}
out vec4 v_color;
void main() {
  int id = gl_VertexID >> 1;
  ivec2 tc = ivec2(id % u_stateW, id / u_stateW);
  vec2 p0 = decodePos(texelFetch(u_prev, tc, 0));
  vec2 p1 = decodePos(texelFetch(u_next, tc, 0));
  vec2 p = (gl_VertexID & 1) == 0 ? p0 : p1;
  float speed = length(wind(p1));
  vec2 clip = (p - u_view.xy) / (u_view.zw - u_view.xy) * 2.0 - 1.0;
  // A respawned particle would draw a streak across the map; push it off-screen instead.
  gl_Position = distance(p0, p1) > 0.01 ? vec4(2.0, 2.0, 0.0, 1.0) : vec4(clip, 0.0, 1.0);
  float land = texture(u_land, p1).r;
  float edge = smoothstep(0.0, 0.03, min(min(p1.x, 1.0 - p1.x), min(p1.y, 1.0 - p1.y)));
  float a = u_alpha * mix(0.42, 1.0, smoothstep(0.5, 14.0, speed)) * mix(1.0, 0.5, land) * edge;
  v_color = vec4(ramp(speed) * a, a);
}`;

const DRAW_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o;
void main() { o = v_color; }`;

const FADE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_fade;
in vec2 v_uv;
out vec4 o;
void main() {
  o = floor(texture(u_tex, v_uv) * 255.0 * u_fade) / 255.0;
}`;

const BLIT_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv); }`;

type Program = { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null>; shaders?: WebGLShader[] };

export interface ParticleOptions {
  count: number;
  /** CSS px per second at 1 m/s. */
  pxPerMs: number;
  fade: number;
  alpha: number;
}

export class ParticleField {
  readonly gl: WebGL2RenderingContext;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private emptyVao: WebGLVertexArrayObject;
  private pUpdate!: Program;
  private pDraw!: Program;
  private pFade!: Program;
  private pBlit!: Program;
  private fb: WebGLFramebuffer;
  private stateA!: WebGLTexture;
  private stateB!: WebGLTexture;
  private trailA: WebGLTexture | null = null;
  private trailB: WebGLTexture | null = null;
  private fieldA: WebGLTexture;
  private fieldB: WebGLTexture;
  private land: WebGLTexture;
  private stateW = 0;
  private stateH = 0;
  private grid: GridSpec | null = null;
  private width = 0;
  private height = 0;
  opts: ParticleOptions;
  mix = 0;
  hasField = false;
  /** True when WebGL is emulated on the CPU (no GPU, or a blocklisted one). */
  software = false;
  /** Resolves once all programs are linked. With KHR_parallel_shader_compile this doesn't block the main thread. */
  readonly ready: Promise<void>;

  constructor(canvas: HTMLCanvasElement, opts: ParticleOptions) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.opts = { ...opts };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    this.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    const progs = [this.program(QUAD_VS, UPDATE_FS), this.program(DRAW_VS, DRAW_FS), this.program(QUAD_VS, FADE_FS), this.program(QUAD_VS, BLIT_FS)];
    [this.pUpdate, this.pDraw, this.pFade, this.pBlit] = progs;
    this.ready = new Promise<void>((resolve, reject) => {
      const check = () => {
        if (parallel && !progs.every((p) => gl.getProgramParameter(p.prog, parallel.COMPLETION_STATUS_KHR))) {
          setTimeout(check, 16);
          return;
        }
        try {
          progs.forEach((p) => this.finishProgram(p));
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      check();
    });

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.emptyVao = gl.createVertexArray()!;
    gl.bindVertexArray(null);
    this.fb = gl.createFramebuffer()!;
    this.fieldA = this.texture(gl.LINEAR);
    this.fieldB = this.texture(gl.LINEAR);
    this.land = this.texture(gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, this.land);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    this.setCount(opts.count);
  }

  get count() {
    return this.stateW * this.stateH;
  }

  setCount(count: number) {
    const gl = this.gl;
    const side = Math.ceil(Math.sqrt(count));
    this.stateW = side;
    this.stateH = Math.ceil(count / side);
    const n = this.stateW * this.stateH * 4;
    const make = () => {
      const data = new Uint8Array(n);
      crypto.getRandomValues(data.subarray(0, Math.min(n, 65536)));
      for (let off = 65536; off < n; off += 65536) crypto.getRandomValues(data.subarray(off, Math.min(n, off + 65536)));
      const t = this.texture(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.stateW, this.stateH, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return t;
    };
    if (this.stateA) gl.deleteTexture(this.stateA);
    if (this.stateB) gl.deleteTexture(this.stateB);
    this.stateA = make();
    this.stateB = make();
  }

  setLandMask(data: Uint8Array, w: number, h: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.land);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  /** Upload the two hourly frames that bracket the displayed time. `mix` blends between them. */
  setFields(grid: GridSpec, a: { u: Float32Array; v: Float32Array }, b: { u: Float32Array; v: Float32Array }) {
    this.grid = grid;
    this.upload(this.fieldA, grid, a);
    this.upload(this.fieldB, grid, b);
    this.hasField = true;
  }

  private upload(tex: WebGLTexture, g: GridSpec, f: { u: Float32Array; v: Float32Array }) {
    const gl = this.gl;
    const n = g.nx * g.ny;
    const rg = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      rg[2 * k] = f.u[k];
      rg[2 * k + 1] = f.v[k];
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, g.nx, g.ny, 0, gl.RG, gl.FLOAT, rg);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const gl = this.gl;
    for (const t of [this.trailA, this.trailB]) if (t) gl.deleteTexture(t);
    const make = () => {
      const t = this.texture(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t;
    };
    this.trailA = make();
    this.trailB = make();
    this.clearTrails();
  }

  clearTrails() {
    const gl = this.gl;
    for (const t of [this.trailA, this.trailB]) {
      if (!t) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Advance and render one frame.
   * @param view   visible rect in domain coords [x0, y0, x1, y1]
   * @param degPerPx degrees latitude per CSS pixel (keeps on-screen speed constant across zoom levels)
   * @param dt     seconds since the previous frame
   */
  frame(view: [number, number, number, number], degPerPx: number, dt: number) {
    if (!this.hasField || !this.grid || !this.trailA || !this.trailB) return;
    const gl = this.gl;
    const g = this.grid;
    const lonSpan = DOMAIN.lonMax - DOMAIN.lonMin;
    const latSpan = DOMAIN.latMax - DOMAIN.latMin;
    const spawn: [number, number, number, number] = [Math.max(view[0], 0), Math.max(view[1], 0), Math.min(view[2], 1), Math.min(view[3], 1)];
    const frames60 = Math.min(dt * 60, 3);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);

    // 1. Update particle state.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.stateB, 0);
    gl.viewport(0, 0, this.stateW, this.stateH);
    this.use(this.pUpdate);
    this.bindFields(this.pUpdate, g);
    this.tex(this.pUpdate, 'u_state', this.stateA, 2);
    const U = this.pUpdate.u;
    gl.uniform1f(U.u_seed, Math.random() + 1);
    gl.uniform1f(U.u_step, this.opts.pxPerMs * degPerPx * Math.min(dt, 0.05));
    gl.uniform4f(U.u_spawn, spawn[0], spawn[1], spawn[2], spawn[3]);
    gl.uniform1f(U.u_drop, 0.0025 * frames60);
    gl.uniform1f(U.u_dropBump, 0.012 * frames60);
    gl.uniform2f(U.u_span, lonSpan, latSpan);
    gl.uniform1f(U.u_lat0, DOMAIN.latMin);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. Fade the previous trails into trailB.
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.trailB, 0);
    gl.viewport(0, 0, this.width, this.height);
    this.use(this.pFade);
    this.tex(this.pFade, 'u_tex', this.trailA, 0);
    gl.uniform1f(this.pFade.u.u_fade, Math.pow(this.opts.fade, frames60));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. Draw the new segments on top.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.emptyVao);
    this.use(this.pDraw);
    this.bindFields(this.pDraw, g);
    this.tex(this.pDraw, 'u_prev', this.stateA, 2);
    this.tex(this.pDraw, 'u_next', this.stateB, 3);
    this.tex(this.pDraw, 'u_land', this.land, 4);
    gl.uniform1i(this.pDraw.u.u_stateW, this.stateW);
    gl.uniform4f(this.pDraw.u.u_view, view[0], view[1], view[2], view[3]);
    gl.uniform1f(this.pDraw.u.u_alpha, this.opts.alpha);
    gl.drawArrays(gl.LINES, 0, this.count * 2);
    gl.disable(gl.BLEND);

    // 4. Show it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.use(this.pBlit);
    this.tex(this.pBlit, 'u_tex', this.trailB, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    [this.stateA, this.stateB] = [this.stateB, this.stateA];
    [this.trailA, this.trailB] = [this.trailB, this.trailA];
  }

  private bindFields(p: Program, g: GridSpec) {
    this.tex(p, 'u_fieldA', this.fieldA, 0);
    this.tex(p, 'u_fieldB', this.fieldB, 1);
    this.gl.uniform1f(p.u.u_mix, this.mix);
    this.gl.uniform2f(p.u.u_grid, g.nx, g.ny);
  }

  private tex(p: Program, name: string, t: WebGLTexture, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(p.u[name], unit);
  }

  private use(p: Program) {
    this.gl.useProgram(p.prog);
  }

  private texture(filter: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private program(vsSrc: string, fsSrc: string): Program {
    const gl = this.gl;
    // No COMPILE_STATUS query here: it would block. Errors surface at link time in finishProgram().
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const prog = gl.createProgram()!;
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    return { prog, u: {}, shaders: [vs, fs] };
  }

  /** Check the link result and collect uniform locations. Querying blocks until linking is done. */
  private finishProgram(p: Program) {
    const gl = this.gl;
    if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
      const logs = (p.shaders ?? []).map((sh) => gl.getShaderInfoLog(sh)).filter(Boolean).join('\n');
      throw new Error(`link: ${gl.getProgramInfoLog(p.prog)} ${logs}`);
    }
    const n = gl.getProgramParameter(p.prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p.prog, i)!;
      p.u[info.name] = gl.getUniformLocation(p.prog, info.name);
    }
  }
}
