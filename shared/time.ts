export const TZ = 'Europe/Zagreb';

/** Europe/Zagreb offset from UTC at a given instant, in minutes (60 in winter, 120 in summer). */
export function zagrebOffsetMinutes(unixMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(unixMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - Math.floor(unixMs / 60000) * 60000) / 60000);
}

/**
 * Convert a Zagreb wall-clock time to unix seconds. DHMZ timestamps are local
 * (e.g. <Datum>19.11.2026</Datum><Termin>18</Termin>). Uses two passes so it is
 * correct on both sides of a DST switch.
 */
export function zagrebToUnix(year: number, month: number, day: number, hour: number): number {
  const naive = Date.UTC(year, month - 1, day, hour);
  let guess = naive - zagrebOffsetMinutes(naive) * 60000;
  guess = naive - zagrebOffsetMinutes(guess) * 60000;
  return Math.round(guess / 1000);
}
