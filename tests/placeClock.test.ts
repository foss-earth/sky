import { describe, expect, it } from 'vitest';
import { placeClockZone } from '../src/panels/placeClock.js';
import { civilClockMs, utcForCivilClockMs } from '../src/time.js';

const minneapolis = { latDeg:44.974516, lonDeg:-93.2375 };
const at = (iso: string) => Date.parse(iso);
const zone = (ms: number) => placeClockZone(minneapolis, ms)!;

describe('civil time at the simulated location', () => {
  it('looks up geographic zones and dated offsets independently of the device zone', () => {
    const ms = at('2026-10-25T23:10:58Z');
    expect(zone(ms)).toMatchObject({id:'America/Chicago',offsetMinutes:-300});
    expect(placeClockZone({latDeg:35.68,lonDeg:139.76},ms)).toMatchObject({id:'Asia/Tokyo',offsetMinutes:540});
    expect(placeClockZone({latDeg:27.7172,lonDeg:85.324},ms)).toMatchObject({id:'Asia/Kathmandu',offsetMinutes:345});
    expect(zone(at('2026-12-25T23:10:58Z')).offsetMinutes).toBe(-360);
    expect(civilClockMs(ms,zone)).toBe(at('2026-10-25T18:10:58Z'));
  });
  it('keeps civil fields through date rollover, repeated hours and spring gaps', () => {
    expect(utcForCivilClockMs(at('2026-10-25T23:30:00Z'),zone)).toBe(at('2026-10-26T04:30:00Z'));
    expect(utcForCivilClockMs(at('2026-11-01T01:30:00Z'),zone)).toBe(at('2026-11-01T06:30:00Z'));
    expect(utcForCivilClockMs(at('2026-03-08T02:30:00Z'),zone)).toBe(at('2026-03-08T08:30:00Z'));
  });
  it('uses an explicit unavailable result while location is unknown', () => {
    expect(placeClockZone(null, Date.now())).toBeNull();
    expect(placeClockZone({latDeg:NaN,lonDeg:0},Date.now())).toBeNull();
  });
});
