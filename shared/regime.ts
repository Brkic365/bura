import { fromUV } from './wind.js';

export type RegimeId = 'bura' | 'jugo' | 'maestral' | 'tramontana' | 'lebic' | 'variable' | 'calm';

export const REGIME_LABEL: Record<RegimeId, { name: string; gloss: string }> = {
  bura: { name: 'Bura', gloss: 'cold, gusty fall wind' },
  jugo: { name: 'Jugo', gloss: 'warm, humid sea wind' },
  maestral: { name: 'Maestral', gloss: 'summer sea breeze' },
  tramontana: { name: 'Tramontana', gloss: 'cool northerly' },
  lebic: { name: 'Lebić', gloss: 'stormy south-westerly' },
  variable: { name: 'Variable', gloss: 'no dominant direction' },
  calm: { name: 'Calm', gloss: 'light winds' },
};

export interface RegimeSample {
  name: string;
  lon: number;
  lat: number;
  u: number;
  v: number;
  gust: number;
}

export interface RegimeSummary {
  regime: RegimeId;
  /** Speed-weighted mean "from" direction over the coastal points. */
  fromDeg: number;
  /** Mean scalar wind speed over the coastal points (m/s). */
  meanSpeed: number;
  /** Directional consistency 0..1 (|Σv| / Σ|v|). */
  steadiness: number;
  gust: { value: number; name: string; lon: number; lat: number };
}

/**
 * Classify the coastal wind regime from samples along the Croatian coast.
 *
 * - Calm: mean speed < 3 m/s and no gust ≥ 10 m/s.
 * - Variable: directions disagree (steadiness < 0.45).
 * - Otherwise by the resultant "from" direction:
 *     350–100° → bura when it is mostly NE (≥ 20°), tramontana when mostly N
 *     100–190° → jugo
 *     190–260° → lebić
 *     260–350° → maestral
 *
 * The sectors are broad on purpose. Bura is channelled through mountain gaps, so it
 * arrives as anything from NNE to ENE depending on where along the coast you stand.
 */
export function classifyRegime(samples: RegimeSample[]): RegimeSummary {
  let su = 0;
  let sv = 0;
  let sSpeed = 0;
  let gust = { value: -1, name: '', lon: 0, lat: 0 };
  for (const s of samples) {
    su += s.u;
    sv += s.v;
    sSpeed += Math.hypot(s.u, s.v);
    if (s.gust > gust.value) gust = { value: s.gust, name: s.name, lon: s.lon, lat: s.lat };
  }
  const n = Math.max(samples.length, 1);
  const meanSpeed = sSpeed / n;
  const resultant = fromUV(su / n, sv / n);
  const steadiness = sSpeed > 0 ? Math.hypot(su, sv) / sSpeed : 0;
  const d = resultant.fromDeg;

  let regime: RegimeId;
  if (meanSpeed < 3 && gust.value < 10) regime = 'calm';
  else if (steadiness < 0.45) regime = 'variable';
  else if (d >= 350 || d < 100) regime = d >= 20 && d < 100 ? 'bura' : 'tramontana';
  else if (d < 190) regime = 'jugo';
  else if (d < 260) regime = 'lebic';
  else regime = 'maestral';

  return {
    regime,
    fromDeg: Math.round(d),
    meanSpeed: round1(meanSpeed),
    steadiness: Math.round(steadiness * 100) / 100,
    gust: { ...gust, value: round1(Math.max(gust.value, 0)) },
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
