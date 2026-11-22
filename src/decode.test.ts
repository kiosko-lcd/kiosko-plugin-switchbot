import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressOfMd, decode, decodeTempHumidity, modelOf } from './decode.ts';

/** Bytes from a Python bytes literal's escapes, as pySwitchbot's tests write them: b"d@d\x05\x00u". */
const py = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === 'x') {
      out.push(parseInt(s.slice(i + 2, i + 4), 16));
      i += 3;
    } else out.push(s.charCodeAt(i));
  }
  return out;
};
const hex = (s: string) => s.match(/../g)!.map((b) => parseInt(b, 16));

/* The owner's devices, as BlueZ gave them (2026-11-22 and -23) */

test("the owner's outdoor meter C7:6B:06:06:05:55: 21.0 °C, 58 %, battery 65 %", () => {
  const d = decode([119, 0, 65], [199, 107, 6, 6, 5, 85, 93, 2, 0, 149, 58, 0]);
  assert.equal(d?.model, 'outdoor-meter');
  assert.equal(d?.kind, 'climate');
  assert.equal(d?.temperature, 21);
  assert.equal(d?.humidity, 58);
  assert.equal(d?.battery, 65);
  assert.equal(d?.fahrenheit, false);
  assert.equal(addressOfMd([199, 107, 6, 6, 5, 85, 93, 2, 0, 149, 58, 0]), 'C7:6B:06:06:05:55');
});

test("the owner's other outdoor meters: one shows °F on its screen, one heard without its scan response", () => {
  const a = decode([119, 192, 64], [199, 107, 6, 6, 44, 37, 19, 14, 1, 141, 185, 0]);
  assert.deepEqual([a?.temperature, a?.humidity, a?.battery, a?.fahrenheit], [13.1, 57, 64, true]);
  const b = decode([119, 192, 70], [200, 107, 130, 6, 105, 107, 141, 14, 2, 147, 60, 0]);
  assert.deepEqual([b?.temperature, b?.humidity, b?.battery], [19.2, 60, 70]);
  // No service data: the model only from what was remembered for this address; no battery.
  const c = decode(undefined, [200, 107, 130, 6, 56, 121, 158, 2, 5, 150, 51, 0], 'outdoor-meter');
  assert.deepEqual([c?.model, c?.temperature, c?.humidity, c?.battery], ['outdoor-meter', 22.5, 51, undefined]);
  assert.equal(decode(undefined, [200, 107, 130, 6, 56, 121, 158, 2, 5, 150, 51, 0])?.model, 'unknown');
});

test("the owner's 'm' device (0x6d) is not a type SwitchBot documents: unknown, no readings", () => {
  const d = decode([109, 0], [193, 138, 100, 34, 98, 151, 0, 255, 107, 3, 119, 177]);
  assert.equal(d?.model, 'unknown');
  assert.equal(d?.kind, 'other');
  assert.equal(d?.type, '0x6d');
  assert.equal(d?.temperature, undefined);
});

test("the owner's B0:E9:FE:A9:EA:B1, heard without service data, reads as a Presence Sensor once its model is known", () => {
  const md = [176, 233, 254, 169, 234, 177, 196, 140, 67, 194, 0, 129];
  assert.equal(decode(undefined, md)?.model, 'unknown');
  const d = decode(undefined, md, 'presence');
  assert.equal(d?.kind, 'presence');
  assert.equal(d?.motion, false);
  assert.equal(d?.batteryRange, '>=60');
  assert.equal(d?.presenceForS, 0x43c2); // no one for 4 h 49 min
  // With its scan response (the product id 0x0010ccc8 at the end), it says what it is.
  assert.equal(decode([0x00, 0x20, 0x64, 0x00, 0x10, 0xcc, 0xc8], md)?.model, 'presence');
  assert.equal(decode([0x00, 0x20, 0x64, 0x00, 0x10, 0xcc, 0xc8], md)?.battery, 100);
});

/* pySwitchbot's test advertisements (tests/test_adv_parser.py), and what it decodes them to */

test('Meter: passive and active (test_wosensor_*)', () => {
  const sd = py('T\\x00\\xe4\\x06\\x985');
  const md = py('\\xd7\\xc1}]\\xebC\\xde\\x03\\x06\\x985');
  for (const [s, m, battery] of [[sd, md, 100], [sd, undefined, 100], [undefined, md, undefined]] as const) {
    const d = decode(s, m, 'meter');
    assert.deepEqual([d?.model, d?.temperature, d?.humidity, d?.battery], ['meter', 24.6, 53, battery]);
  }
  // All zeros: a meter still starting, no reading (test_wosensor_active_zero_data).
  assert.equal(decode(py('T\\x00\\x00\\x00\\x00\\x00'), undefined)?.temperature, undefined);
});

test('Meter Pro and Meter Pro CO2 (test_meter_pro_*), CO2 over 9999 ppm dropped', () => {
  const pro = decode(py('4\\x00d'), py('\\xb0\\xe9\\xfeR\\xdd\\x84\\x06d\\x08\\x97,\\x00\\x05'));
  assert.deepEqual([pro?.model, pro?.temperature, pro?.humidity, pro?.battery], ['meter-pro', 23.8, 44, 100]);
  assert.equal(decode([0x14, 0, 0x64], py('\\xb0\\xe9\\xfeR\\xdd\\x84\\x06d\\x08\\x97,\\x00\\x05'))?.model, 'meter-pro');
  const co2 = decode(py('5\\x00d'), py('\\xb0\\xe9\\xfeT2\\x15\\xb7\\xe4\\x07\\x9b\\xa4\\x007\\x02\\xd5\\x00'));
  assert.deepEqual([co2?.model, co2?.temperature, co2?.humidity, co2?.co2], ['meter-pro-co2', 27.7, 36, 725]);
  const glitch = decode(py('5\\x00d'), py('\\xb0\\xe9\\xfeT2\\x15\\xb7\\xe4\\x07\\x9b\\xa4\\x007\\x9c\\x40\\x00'));
  assert.equal(glitch?.co2, undefined);
  assert.equal(glitch?.temperature, 27.7);
});

test('Hub 2 (test_wohub2_passive_and_active)', () => {
  const d = decode(py('v\\x00'), py('\\xaa\\xbb\\xcc\\xdd\\xee\\xff\\x00\\xfffT\\x1a\\xf1\\x82\\x07\\x9a2\\x00'));
  assert.deepEqual([d?.model, d?.temperature, d?.humidity, d?.battery], ['hub2', 26.7, 50, undefined]);
});

test('Weather Station by its product id (test_weather_station_active)', () => {
  const d = decode(py('\\x00\\x00\\x50\\x00\\x10\\x53\\xb0'), py('\\xaa\\xbb\\xcc\\xdd\\xee\\xff\\x01\\x50\\x06\\x9a\\x23\\x00\\x00\\x00\\x00\\x00'));
  assert.deepEqual([d?.model, d?.temperature, d?.humidity, d?.battery], ['weather-station', 26.6, 35, 80]);
});

test('Contact Sensor: service data only, open past its timer (test_parse_advertisement_data_contact)', () => {
  const d = decode(py('d@d\\x05\\x00u\\x00\\xf8\\x12'), py('\\xe7\\xabF\\xac\\x8f\\x92|\\x0f\\x00\\x11\\x04'));
  assert.equal(d?.model, 'contact');
  assert.deepEqual([d?.open, d?.leftOpen, d?.motion, d?.light, d?.battery, d?.buttonCount], [true, true, true, true, 100, 2]);
  // SwitchBot's contactsensor.md: bytes 4–5 seconds since the PIR, 6–7 since the contact changed.
  assert.equal(d?.motionAgeS, 0x75);
  assert.equal(d?.contactAgeS, 0xf8);
});

test('Contact Sensor: open and closed, with the new 13-byte manufacturer data (test_contact_sensor_open/_closed)', () => {
  const open = decode(py('d@\\xda\\x02\\x00\\x17\\x00QD'), py('\\xcb9\\xcd\\xc4=F\\x84\\x9c\\x00\\x17\\x00QD'));
  assert.deepEqual([open?.open, open?.leftOpen, open?.motion, open?.light, open?.battery, open?.buttonCount, open?.contactAgeS], [true, false, true, false, 90, 4, 81]);
  const closed = decode(py('d@\\xda\\x00\\x00+\\x00\\x19\\x84'), py('\\xcb9\\xcd\\xc4=F\\x89\\x8c\\x00+\\x00\\x19\\x84'));
  assert.deepEqual([closed?.open, closed?.motion, closed?.contactAgeS, closed?.motionAgeS], [false, true, 25, 43]);
  // Manufacturer data alone (a passive scan): the same state and ages, no battery.
  const passive = decode(undefined, py('\\xcb9\\xcd\\xc4=F\\x84\\x9c\\x00\\x17\\x00QD'), 'contact');
  assert.deepEqual([passive?.open, passive?.contactAgeS, passive?.battery], [true, 81, undefined]);
});

test('Contact Sensor: the 17th bit of its timers (byte 3, bits 7 and 6)', () => {
  const d = decode([0x64, 0x00, 0x50, 0x02 | 0x40 | 0x80, 0x00, 0x10, 0x00, 0x20, 0x01], undefined);
  assert.equal(d?.contactAgeS, 0x10020);
  assert.equal(d?.motionAgeS, 0x10010);
});

test('Motion Sensor: clear, motion, bright (test_motion_sensor_*)', () => {
  const clear = decode(py('s\\x00\\xe2\\x00f\\x01'), py('\\xc0!\\x9a\\xe8\\xbcIj\\x1c\\x00f'));
  assert.deepEqual([clear?.model, clear?.motion, clear?.battery, clear?.light, clear?.motionAgeS], ['motion', false, 98, false, 102]);
  const moving = decode(py('s@\\xe2\\x008\\x01'), py('\\xc0!\\x9a\\xe8\\xbcIi\\\\\\x008'));
  assert.deepEqual([moving?.motion, moving?.motionAgeS], [true, 56]);
  const bright = decode(py('s\\x00\\xe2\\x04g\\x02'), undefined);
  assert.equal(bright?.light, true);
  // Passive: the age from manufacturer data bytes 8–9.
  const passive = decode(undefined, py('\\xc0!\\x9a\\xe8\\xbcIj\\x1c\\x00f'), 'motion');
  assert.deepEqual([passive?.motion, passive?.motionAgeS, passive?.battery], [false, 102, undefined]);
});

test('Presence Sensor (pySwitchbot AdvTestCase)', () => {
  const d = decode(py('\\x00 d\\x00\\x10\\xcc\\xc8'), py('\\xb0\\xe9\\xfelf\\xaa\\x06\\xcc\\x04V\\x00\\x8c'));
  assert.deepEqual([d?.model, d?.motion, d?.batteryRange, d?.presenceForS, d?.battery], ['presence', true, '>=60', 1110, 100]);
});

/* Edge cases */

test('temperatures under zero, tenths, and °F on the device', () => {
  // Sign bit clear: below zero. −3.7 °C, 90 %.
  assert.deepEqual(decodeTempHumidity([0x07, 0x03, 90]), { temperature: -3.7, humidity: 90, fahrenheit: false });
  assert.deepEqual(decodeTempHumidity([0x09, 0x80 | 30, 0x80 | 40]), { temperature: 30.9, humidity: 40, fahrenheit: true });
  assert.deepEqual(decodeTempHumidity([0x00, 0x80, 45]), { temperature: 0, humidity: 45, fahrenheit: false });
  assert.equal(decodeTempHumidity([0, 0, 0]), null);
  assert.equal(decodeTempHumidity([1, 2]), null);
  const outdoorFrost = decode([0x77, 0, 50], [...hex('c76b06060555'), 1, 2, 0x05, 0x08, 85, 0]);
  assert.equal(outdoorFrost?.temperature, -8.5);
});

test('short, missing and foreign data never throw', () => {
  assert.equal(decode(undefined, undefined), null);
  assert.equal(decode([], []), null);
  assert.equal(decode([0x77], undefined)?.temperature, undefined);
  assert.equal(decode([0x64, 0, 0x50], undefined)?.open, undefined); // a contact sensor's short scan response
  assert.equal(decode([0x73], [1, 2, 3])?.motion, undefined);
  assert.equal(decode(undefined, [1, 2, 3, 4, 5, 6, 7], 'presence')?.motion, undefined);
  assert.equal(modelOf([0x00, 0x00]), undefined);
});

test('an encrypted advertisement is said to be so, and not read', () => {
  const d = decode([0x80 | 0x54, 0x00, 0x64, 0x01, 0x95, 0x30], undefined);
  assert.equal(d?.model, 'meter');
  assert.equal(d?.encrypted, true);
  assert.equal(d?.temperature, undefined);
  assert.equal(d?.battery, undefined);
});

test('pair mode and constant advertising name the same model; other products are named, not read', () => {
  assert.equal(decode([0x44, 0, 0x50, 0, 0, 0, 0, 0, 0], undefined)?.model, 'contact');
  assert.equal(decode([0x53, 0, 0x50, 0, 0, 0], undefined)?.model, 'motion');
  const bot = decode([0x48, 0x00, 0x64], undefined);
  assert.deepEqual([bot?.model, bot?.modelName, bot?.kind], ['bot', 'Bot', 'other']);
  assert.equal(decode([0x26, 0x00, 0x4e], undefined)?.modelName, 'Water Leak Detector');
});
