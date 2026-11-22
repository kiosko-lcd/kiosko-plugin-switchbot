import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_STEP_MS, addSample, applyAdverts, emptyStore, forget, historyWindow, normalizeAddress, reviveStore, trendOf, viewOf } from './state.ts';
import type { Advert, History } from './types.ts';

const T0 = Date.parse('2026-11-23T10:00:00Z');
const MIN = 60_000;
const DOOR = 'CB:39:CD:C4:3D:46';
/** A contact sensor's scan response: open or not, seconds since the contact changed. */
const contactSd = (open: boolean, ageS: number): number[] => [0x64, 0x00, 0x5a, open ? 0x02 : 0x00, 0x00, 0x10, (ageS >> 8) & 0xff, ageS & 0xff, 0x41];
const door = (at: number, open: boolean, ageS: number): Advert => ({ address: DOOR, at, sd: contactSd(open, ageS), rssi: -70 });
const view = (s: ReturnType<typeof emptyStore>, now: number) => viewOf(s, now, { devices: [], names: {}, staleMs: 15 * MIN });

test('a door: its open episode starts when the sensor says it opened, and stays put while it is open', () => {
  let s = applyAdverts(emptyStore(), [door(T0, true, 120)]);
  assert.equal(s.devices[DOOR]!.openSince, T0 - 120_000);
  // A minute later, still open: the same episode, even if the sensor's count wobbles.
  s = applyAdverts(s, [door(T0 + MIN, true, 181)]);
  assert.equal(s.devices[DOOR]!.openSince, T0 - 120_000);
  // Closed: no episode, and when it closed.
  s = applyAdverts(s, [door(T0 + 2 * MIN, false, 30)]);
  assert.equal(s.devices[DOOR]!.openSince, undefined);
  assert.equal(s.devices[DOOR]!.closedAt, T0 + 2 * MIN - 30_000);
  // Opened again: a new episode.
  s = applyAdverts(s, [door(T0 + 5 * MIN, true, 10)]);
  assert.equal(s.devices[DOOR]!.openSince, T0 + 5 * MIN - 10_000);
});

test('a door closed and opened again between two windows is a new episode', () => {
  let s = applyAdverts(emptyStore(), [door(T0, true, 0)]);
  // Next window: open, but the sensor says it changed 20 s ago, long after the episode began.
  s = applyAdverts(s, [door(T0 + 10 * MIN, true, 20)]);
  assert.equal(s.devices[DOOR]!.openSince, T0 + 10 * MIN - 20_000);
});

test('a motion sensor: last motion from its own timer, never going back', () => {
  const addr = 'C0:21:9A:E8:BC:49';
  let s = applyAdverts(emptyStore(), [{ address: addr, at: T0, sd: [0x73, 0x00, 0x62, 0x00, 102, 0x01] }]);
  assert.equal(s.devices[addr]!.lastMotion, T0 - 102_000);
  assert.equal(s.devices[addr]!.battery, 98);
  s = applyAdverts(s, [{ address: addr, at: T0 + MIN, sd: [0x73, 0x40, 0x62, 0x00, 2, 0x01] }]);
  assert.equal(s.devices[addr]!.lastMotion, T0 + MIN);
  assert.equal(s.devices[addr]!.motion, true);
  // Only manufacturer data now: the battery heard before is kept.
  s = applyAdverts(s, [{ address: addr, at: T0 + 2 * MIN, md: [0xc0, 0x21, 0x9a, 0xe8, 0xbc, 0x49, 0x6a, 0x1c, 0x00, 0x3c] }]);
  assert.equal(s.devices[addr]!.battery, 98);
  assert.equal(s.devices[addr]!.motion, false);
  assert.equal(s.devices[addr]!.lastMotion, T0 + MIN);
});

test('a model learnt from a scan response reads that device later without one', () => {
  const addr = 'C8:6B:82:06:38:79';
  const md = [200, 107, 130, 6, 56, 121, 158, 2, 5, 150, 51, 0];
  let s = applyAdverts(emptyStore(), [{ address: addr, at: T0, md }]);
  assert.equal(s.devices[addr]!.model, 'unknown');
  s = applyAdverts(s, [{ address: addr, at: T0 + MIN, md, sd: [0x77, 0xc0, 0x40] }]);
  assert.equal(s.models[addr], 'outdoor-meter');
  s = applyAdverts(s, [{ address: addr, at: T0 + 2 * MIN, md: [...md.slice(0, 9), 0x96, 52, 0] }]);
  assert.equal(s.devices[addr]!.temperature, 22.5);
  assert.equal(s.devices[addr]!.humidity, 52);
  assert.equal(s.devices[addr]!.battery, 64);
});

test('stale after staleMs, names by address in any spelling, filters', () => {
  const s = applyAdverts(emptyStore(), [door(T0, false, 5), { address: 'C7:6B:06:06:05:55', at: T0, sd: [119, 0, 65], md: [199, 107, 6, 6, 5, 85, 93, 2, 0, 149, 58, 0] }]);
  assert.deepEqual(view(s, T0 + 10 * MIN).map((d) => d.stale), [false, false]);
  assert.deepEqual(view(s, T0 + 16 * MIN).map((d) => d.stale), [true, true]);
  const named = viewOf(s, T0, { devices: [], names: { 'c7-6b-06-06-05-55': 'Salón' }, staleMs: 15 * MIN });
  assert.equal(named[0]!.name, 'Salón');
  assert.equal(named[0]!.kind, 'climate'); // thermometers first
  assert.deepEqual(viewOf(s, T0, { devices: ['!Salón'], names: { C76B06060555: 'Salón' }, staleMs: 15 * MIN }).map((d) => d.kind), ['contact']);
  assert.deepEqual(viewOf(s, T0, { devices: ['contact'], names: {}, staleMs: 15 * MIN }).map((d) => d.key), [DOOR]);
  assert.equal(normalizeAddress('nope'), undefined);
});

test('history: one value per 5 minutes, a day of them, and a trend over the last hour', () => {
  let h = addSample(undefined, T0, 20, 50);
  for (let i = 1; i <= 12; i++) h = addSample(h, T0 + i * HISTORY_STEP_MS, 20 + i * 0.1, 50);
  assert.equal(h.temp.length, 13);
  assert.equal(trendOf(h), 'up');
  // A gap: buckets with no reading are null.
  h = addSample(h, T0 + 20 * HISTORY_STEP_MS, 20.5, 50);
  assert.equal(h.temp[15], null);
  // A day later the oldest go.
  const late = addSample(h, T0 + 30 * 3600_000, 19, 50);
  assert.equal(late.temp.length, 288);
  assert.equal(late.t0, T0 + 30 * 3600_000 - 287 * HISTORY_STEP_MS);
  const flat = [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20.1].reduce<History | undefined>((acc, v, i) => addSample(acc, T0 + i * HISTORY_STEP_MS, v, 50), undefined);
  assert.equal(trendOf(flat), 'flat');
  assert.equal(trendOf(addSample(undefined, T0, 20, 50)), null);
  const w = historyWindow(h, T0 + 20 * HISTORY_STEP_MS, 3600_000)!;
  assert.equal(w.temp.length, 12);
  assert.equal(w.temp[11], 20.5);
});

test('a thermometer adds to its history; devices gone for a month are forgotten', () => {
  const s = applyAdverts(emptyStore(), [{ address: 'C7:6B:06:06:05:55', at: T0, sd: [119, 0, 65], md: [199, 107, 6, 6, 5, 85, 93, 2, 0, 149, 58, 0] }]);
  assert.equal(s.history['C7:6B:06:06:05:55']!.temp.at(-1), 21);
  assert.equal(Object.keys(forget(s, T0 + 31 * 24 * 3600_000).devices).length, 0);
  assert.equal(forget(s, T0 + 3600_000), s);
});

test('a state file that is not ours is ignored', () => {
  assert.deepEqual(reviveStore(null), emptyStore());
  assert.deepEqual(reviveStore({ v: 2 }), emptyStore());
  assert.deepEqual(reviveStore({ v: 1, models: [], devices: 'x' }).devices, {});
});
