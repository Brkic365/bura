/**
 * The single accent ramp: wind speed (m/s) → colour. It runs from deep sea-teal through glacier
 * cyan to white-hot for storm gusts. The particle shader, the legend and the station dots all
 * read these stops.
 */
export const RAMP: [number, string][] = [
  [0, '#0f2a36'],
  [3, '#16566b'],
  [7, '#1c97b8'],
  [11, '#3fd0f0'],
  [16, '#a6efff'],
  [22, '#f2fdff'],
  [30, '#ffffff'],
];

export const RAMP_MAX = 30;

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rampColor(speed: number): string {
  const s = Math.max(0, Math.min(RAMP_MAX, speed));
  for (let i = 1; i < RAMP.length; i++) {
    if (s <= RAMP[i][0]) {
      const [s0, c0] = RAMP[i - 1];
      const [s1, c1] = RAMP[i];
      const t = (s - s0) / (s1 - s0);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      const mix = a.map((x, k) => Math.round((x + (b[k] - x) * t) * 255));
      return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/** CSS linear-gradient for the legend. */
export function rampGradient(): string {
  return `linear-gradient(90deg, ${RAMP.map(([s, c]) => `${c} ${((s / RAMP_MAX) * 100).toFixed(1)}%`).join(', ')})`;
}

/** GLSL source for `vec3 ramp(float speed)`, generated from the same stops. */
export function rampGlsl(): string {
  const stops = RAMP.map(([s, c]) => {
    const [r, g, b] = hexToRgb(c);
    return { s: s.toFixed(1), c: `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})` };
  });
  let body = `  vec3 c = ${stops[0].c};\n`;
  for (let i = 1; i < stops.length; i++) {
    body += `  c = mix(c, ${stops[i].c}, clamp((s - ${stops[i - 1].s}) / (${stops[i].s} - ${stops[i - 1].s}), 0.0, 1.0));\n`;
  }
  return `vec3 ramp(float s) {\n${body}  return c;\n}\n`;
}
