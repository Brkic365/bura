import { describe, expect, it } from 'vitest';
import { classifyRegime } from '../shared/regime';
import { zagrebToUnix } from '../shared/time';
import { compass, fromUV, parseDirection, toUV } from '../shared/wind';

describe('wind conventions', () => {
  it('a northerly (from 0°) blows toward the south: v < 0', () => {
    const [u, v] = toUV(0, 10);
    expect(u).toBeCloseTo(0, 6);
    expect(v).toBeCloseTo(-10, 6);
  });

  it('bura (from NE, 45°) blows toward the SW: u < 0, v < 0', () => {
    const [u, v] = toUV(45, 10);
    expect(u).toBeLessThan(0);
    expect(v).toBeLessThan(0);
  });

  it('round-trips direction and speed', () => {
    for (let d = 0; d < 360; d += 15) {
      const [u, v] = toUV(d, 7.5);
      const r = fromUV(u, v);
      expect(r.speed).toBeCloseTo(7.5, 5);
      expect(r.fromDeg % 360).toBeCloseTo(d, 4);
    }
  });

  it('parses compass points, degrees and calm markers', () => {
    expect(parseDirection('NE')).toEqual({ kind: 'deg', deg: 45 });
    expect(parseDirection(' sse ')).toEqual({ kind: 'deg', deg: 157.5 });
    expect(parseDirection('270')).toEqual({ kind: 'deg', deg: 270 });
    expect(parseDirection('360')).toEqual({ kind: 'deg', deg: 0 });
    expect(parseDirection('C')).toEqual({ kind: 'calm' });
    expect(parseDirection('0')).toEqual({ kind: 'calm' });
    expect(parseDirection('-')).toEqual({ kind: 'unknown' });
    expect(parseDirection('XYZ')).toEqual({ kind: 'unknown' });
  });

  it('understands Croatian abbreviations only when asked (S = sjever = north)', () => {
    expect(parseDirection('SI', true)).toEqual({ kind: 'deg', deg: 45 });
    expect(parseDirection('S', true)).toEqual({ kind: 'deg', deg: 0 });
    expect(parseDirection('S')).toEqual({ kind: 'deg', deg: 180 });
  });

  it('names directions on a 16-point rose', () => {
    expect(compass(44)).toBe('NE');
    expect(compass(359)).toBe('N');
    expect(compass(135)).toBe('SE');
  });
});

describe('zagrebToUnix', () => {
  it('handles winter time (UTC+1)', () => {
    expect(zagrebToUnix(2026, 11, 19, 18)).toBe(Date.UTC(2026, 10, 19, 17) / 1000);
  });
  it('handles summer time (UTC+2)', () => {
    expect(zagrebToUnix(2026, 7, 1, 14)).toBe(Date.UTC(2026, 6, 1, 12) / 1000);
  });
  it('handles the hours around the spring-forward switch', () => {
    // 29 Mar 2026: 02:00 local jumps to 03:00. 01:00 is still CET; 04:00 is CEST.
    expect(zagrebToUnix(2026, 3, 29, 1)).toBe(Date.UTC(2026, 2, 29, 0) / 1000);
    expect(zagrebToUnix(2026, 3, 29, 4)).toBe(Date.UTC(2026, 2, 29, 2) / 1000);
  });
});

describe('classifyRegime', () => {
  const pts = (fromDeg: number, speed: number, gust = speed * 1.5) =>
    Array.from({ length: 10 }, (_, i) => {
      const [u, v] = toUV(fromDeg + (i % 3) * 5 - 5, speed);
      return { name: `P${i}`, lon: 14 + i * 0.3, lat: 45 - i * 0.2, u, v, gust: gust + i };
    });

  it('detects bura', () => expect(classifyRegime(pts(50, 12)).regime).toBe('bura'));
  it('detects jugo', () => expect(classifyRegime(pts(135, 10)).regime).toBe('jugo'));
  it('detects maestral', () => expect(classifyRegime(pts(305, 6)).regime).toBe('maestral'));
  it('detects tramontana', () => expect(classifyRegime(pts(5, 9)).regime).toBe('tramontana'));
  it('names the rest of the rose', () => {
    expect(classifyRegime(pts(95, 9)).regime).toBe('levant');
    expect(classifyRegime(pts(185, 9)).regime).toBe('ostro');
    expect(classifyRegime(pts(225, 9)).regime).toBe('lebic');
    expect(classifyRegime(pts(270, 9)).regime).toBe('pulenat');
  });
  it('calls light winds calm', () => expect(classifyRegime(pts(50, 1.5, 0)).regime).toBe('calm'));
  it('calls disagreeing directions variable', () => {
    const mixed = [...pts(45, 8).slice(0, 5), ...pts(225, 8).slice(0, 5)];
    expect(classifyRegime(mixed).regime).toBe('variable');
  });
  it('reports the strongest gust and where it was', () => {
    const s = classifyRegime(pts(50, 12, 20));
    expect(s.gust.value).toBe(29);
    expect(s.gust.name).toBe('P9');
  });
});
