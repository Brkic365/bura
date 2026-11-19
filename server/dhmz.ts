/**
 * DHMZ (Croatian Meteorological and Hydrological Service) current observations.
 *
 * Feed: https://vrijeme.hr/hrvatska_n.xml, listed on
 * https://meteo.hr/proizvodi.php?section=podaci&param=xml_korisnici and published under the
 * Open Licence of the Republic of Croatia (attribution required).
 *
 * Shape (abridged):
 *   <Hrvatska>
 *     <DatumTermin><Datum>19.11.2026</Datum><Termin>18</Termin></DatumTermin>   ← local time
 *     <Grad>
 *       <GradIme>Senj</GradIme><Lat>44.99</Lat><Lon>14.90</Lon>
 *       <Podatci><Temp>9.1</Temp>…<VjetarSmjer>NE</VjetarSmjer><VjetarBrzina>12.3</VjetarBrzina>…</Podatci>
 *     </Grad>
 *   </Hrvatska>
 *
 * Hourly, current hour only (no history), no gusts. Wind speed is in m/s and direction is a
 * compass point. "-" means missing.
 */
import { XMLParser } from 'fast-xml-parser';
import { zagrebToUnix } from '../shared/time.js';
import type { ObsSnapshot, Station } from '../shared/types.js';
import { parseDirection } from '../shared/wind.js';

export const DHMZ_URL = 'https://vrijeme.hr/hrvatska_n.xml';

/**
 * Mountain-top stations. Their winds are real but don't represent the 10 m surface field over
 * the coast and sea, so they are left out of the correction.
 */
const EXCLUDED = ['zavižan', 'parg', 'puntijarka', 'sljeme', 'bjelolasica', 'mrkopalj', 'učka'];
/** DHMZ names carry prefixes like "RC " (regional centre) or "GMP ", so match loosely. */
export const isExcludedStation = (name: string) => {
  const n = name.toLowerCase();
  return EXCLUDED.some((x) => n.includes(x));
};

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true, parseTagValue: false, isArray: (name) => name === 'Grad' });

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(',', '.').replace(/\*$/, '');
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function parseDhmzXml(xml: string): ObsSnapshot {
  const doc = parser.parse(xml);
  const root = doc?.Hrvatska;
  if (!root) throw new Error('DHMZ: missing <Hrvatska> root');
  const datum = String(root.DatumTermin?.Datum ?? '').trim();
  const termin = String(root.DatumTermin?.Termin ?? '').trim();
  const m = datum.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/);
  const hour = Number(termin);
  if (!m || !Number.isInteger(hour)) throw new Error(`DHMZ: bad DatumTermin "${datum} ${termin}"`);
  const t = zagrebToUnix(Number(m[3]), Number(m[2]), Number(m[1]), hour);

  const stations: Station[] = [];
  for (const g of root.Grad ?? []) {
    const name = String(g.GradIme ?? '').trim();
    const lat = num(g.Lat);
    const lon = num(g.Lon);
    const speed = num(g.Podatci?.VjetarBrzina);
    if (!name || lat === null || lon === null || speed === null || speed < 0 || speed > 70) continue;
    if (isExcludedStation(name)) continue;
    const dir = parseDirection(g.Podatci?.VjetarSmjer);
    if (dir.kind === 'unknown' && speed > 0) continue;
    stations.push({
      name,
      lon,
      lat,
      fromDeg: dir.kind === 'deg' && speed > 0 ? dir.deg : null,
      speed: dir.kind === 'calm' ? 0 : speed,
    });
  }
  return { t, stations };
}

/** The feed declares its own encoding (historically windows-1250), so decode from bytes and honour the prolog. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 200));
  const enc = head.match(/encoding=["']([\w-]+)["']/i)?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function fetchDhmz(fetchImpl: typeof fetch = fetch): Promise<ObsSnapshot> {
  let res: Response;
  try {
    res = await fetchImpl(DHMZ_URL, { headers: { 'User-Agent': 'bura-wind-map (portfolio project)' } });
  } catch (err) {
    // vrijeme.hr has served a mismatched TLS certificate before. Fall back to plain HTTP:
    // the feed is public and read-only.
    res = await fetchImpl(DHMZ_URL.replace('https://', 'http://'), { headers: { 'User-Agent': 'bura-wind-map (portfolio project)' } });
    if (!res.ok) throw err;
  }
  if (!res.ok) throw new Error(`DHMZ HTTP ${res.status}`);
  return parseDhmzXml(decodeXmlBytes(new Uint8Array(await res.arrayBuffer())));
}
