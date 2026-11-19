/**
 * Wind conventions. Direction is meteorological: the bearing the wind blows FROM, degrees clockwise
 * from north. Components: u = eastward, v = northward (m/s).
 */
const RAD = Math.PI / 180;

const COMPASS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const;

/** Croatian abbreviations sometimes seen in DHMZ products (S=sjever, J=jug, I=istok, Z=zapad). */
const CROATIAN: Record<string, string> = {
  S: 'N', SSI: 'NNE', SI: 'NE', ISI: 'ENE', I: 'E', IJI: 'ESE', JI: 'SE', JJI: 'SSE',
  J: 'S', JJZ: 'SSW', JZ: 'SW', ZJZ: 'WSW', Z: 'W', ZSZ: 'WNW', SZ: 'NW', SSZ: 'NNW',
};

export type ParsedDirection = { kind: 'deg'; deg: number } | { kind: 'calm' } | { kind: 'unknown' };

/**
 * Parse a direction field. Accepts English compass points ("NE"), numeric degrees ("45"),
 * calm markers ("C", "0", "tišina", "calm") and, if `croatian` is true, Croatian abbreviations.
 * English is the default because "S" is ambiguous (south vs sjever).
 */
export function parseDirection(raw: string | number | null | undefined, croatian = false): ParsedDirection {
  if (raw === null || raw === undefined) return { kind: 'unknown' };
  const s = String(raw).trim().toUpperCase();
  if (!s || s === '-' || s === '--' || s === 'VAR' || s === 'PROM') return { kind: 'unknown' };
  if (s === 'C' || s === 'CALM' || s === 'TIŠINA' || s === 'TISINA' || s === 'TIH') return { kind: 'calm' };
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const d = Number(s);
    if (d === 0) return { kind: 'calm' }; // WMO: 0 = calm, 360 = north
    return d > 0 && d <= 360 ? { kind: 'deg', deg: d % 360 } : { kind: 'unknown' };
  }
  const key = croatian && CROATIAN[s] ? CROATIAN[s] : s;
  const idx = COMPASS.indexOf(key as (typeof COMPASS)[number]);
  return idx >= 0 ? { kind: 'deg', deg: idx * 22.5 } : { kind: 'unknown' };
}

export function toUV(fromDeg: number, speed: number): [number, number] {
  return [-speed * Math.sin(fromDeg * RAD), -speed * Math.cos(fromDeg * RAD)];
}

export function fromUV(u: number, v: number): { speed: number; fromDeg: number } {
  const speed = Math.hypot(u, v);
  let deg = Math.atan2(-u, -v) / RAD;
  if (deg < 0) deg += 360;
  return { speed, fromDeg: speed < 1e-9 ? 0 : deg };
}

export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function beaufort(speed: number): number {
  const limits = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const b = limits.findIndex((l) => speed < l);
  return b === -1 ? 12 : b;
}
