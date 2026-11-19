import { fromUV } from './wind.js';

export type RegimeId = 'bura' | 'levant' | 'jugo' | 'ostro' | 'lebic' | 'pulenat' | 'maestral' | 'tramontana' | 'variable' | 'calm';

export const REGIME_LABEL: Record<RegimeId, { name: string; gloss: string }> = {
  bura: { name: 'Bura', gloss: 'cold, gusty fall wind' },
  levant: { name: 'Levant', gloss: 'easterly' },
  jugo: { name: 'Jugo', gloss: 'warm, humid sea wind' },
  ostro: { name: 'Oštro', gloss: 'southerly' },
  lebic: { name: 'Lebić', gloss: 'stormy south-westerly' },
  pulenat: { name: 'Pulenat', gloss: 'westerly' },
  maestral: { name: 'Maestral', gloss: 'north-westerly, fair weather' },
  tramontana: { name: 'Tramontana', gloss: 'cool northerly' },
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
 * - Otherwise by the resultant "from" direction, on the traditional Adriatic wind rose:
 *     tramontana N (340–20°) · bura NE (20–80°) · levant E (80–110°) · jugo SE (110–170°)
 *     oštro S (170–200°) · lebić SW (200–245°) · pulenat W (245–290°) · maestral NW (290–340°)
 *
 * Bura and jugo get the widest sectors on purpose. Bura is channelled through mountain gaps,
 * so it arrives as anything from NNE to ENE depending on where along the coast you stand.
 * Jugo follows the coast's NW–SE axis.
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
  else if (d >= 340 || d < 20) regime = 'tramontana';
  else if (d < 80) regime = 'bura';
  else if (d < 110) regime = 'levant';
  else if (d < 170) regime = 'jugo';
  else if (d < 200) regime = 'ostro';
  else if (d < 245) regime = 'lebic';
  else if (d < 290) regime = 'pulenat';
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
