import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { THEMES, createBaseContext, defaultsOf } from '@kiosko/sdk';
import { widgetState } from '@kiosko/sdk/testing';
import { MIN_PX, SOURCE } from './common.ts';
import { demoData } from './demo.ts';
import type { SwitchBotData } from './types.ts';
import { batteries, climate, doors, gridFor, presence, sortDoors } from './widgets.ts';

const now = Date.parse('2026-11-23T10:42:00Z');
const theme = THEMES[0]!;
type W = typeof climate | typeof doors | typeof presence | typeof batteries;

/** Paints a widget and returns every text drawn, with its size. */
function paint(w: W, data: SwitchBotData | undefined, size: [number, number], locale: string, options: Record<string, unknown> = {}) {
  const texts: { text: string; size: number }[] = [];
  const spy = { ...kit, drawTracked: (g: never, text: string, x: number, y: number, o: { size: number }) => (texts.push({ text, size: o.size }), kit.drawTracked(g, text, x, y, o as never)) };
  const g = createCanvas(size[0], size[1]).getContext('2d');
  const opts = { ...(defaultsOf(w.options as never) as Record<string, unknown>), ...options };
  w.render(g as never, { ...createBaseContext({ now, locale }), options: opts, data: undefined, sources: data ? { [SOURCE]: data } : {}, working: true, box: { x: 0, y: 0, w: size[0], h: size[1] }, theme, fonts: theme.fonts, kit: spy, canvas: { createCanvas }, preview: true } as never);
  return texts;
}

const SIZES: [number, number][] = [[1920, 462], [600, 462], [480, 240], [320, 110], [172, 320], [156, 148], [200, 60], [160, 24], [140, 18]];
const LOCALES = ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'];

const calm = (l: string): SwitchBotData => {
  const d = demoData(now, l);
  return { ...d, devices: d.devices.map((x) => ({ ...x, ...(x.kind === 'contact' ? { open: false, openSince: undefined } : {}), ...(x.battery !== undefined && x.battery < 30 ? { battery: 64 } : {}) })) };
};

test('nothing under 11 px, in every language and size, and something is painted', () => {
  for (const locale of LOCALES)
    for (const size of SIZES)
      for (const w of [climate, doors, presence, batteries] as W[])
        for (const data of [demoData(now, locale), calm(locale), undefined, { ...demoData(now, locale), devices: [] }]) {
          const texts = paint(w, data, size, locale);
          assert.ok(texts.length > 0, `${w.id} ${size} ${locale} paints`);
          assert.deepEqual(texts.filter((t) => t.size < MIN_PX), [], `${w.id} ${size.join('x')} ${locale}`);
        }
});

test('climate: every thermometer with its temperature and humidity, as the language writes them', () => {
  const t = paint(climate, demoData(now, 'es'), [1920, 462], 'es').map((x) => x.text);
  for (const s of ['Salón', '21,5°', '52 %', 'Exterior', '8,4°']) assert.ok(t.includes(s), s);
  const en = paint(climate, demoData(now, 'en'), [480, 240], 'en').map((x) => x.text);
  assert.ok(en.includes('21.5°') && en.includes('52%'));
  // In °F, when asked.
  const f = paint(climate, { ...demoData(now, 'en'), units: 'fahrenheit' }, [480, 240], 'en').map((x) => x.text);
  assert.ok(f.includes('70.7°F'), f.join(' '));
  // One thermometer fills a portrait tile.
  const one = paint(climate, demoData(now, 'es'), [172, 320], 'es', { devices: ['Salón'] });
  assert.ok(one.find((x) => x.text === '21,5°')!.size >= 48);
});

test('climate: a thermometer not heard for a while says since when', () => {
  const d = demoData(now, 'en');
  d.devices = d.devices.map((x) => (x.name === 'Outside' ? { ...x, stale: true, lastSeen: now - 3 * 3600_000 } : x));
  assert.ok(paint(climate, d, [1920, 462], 'en').some((x) => /3 h ago/.test(x.text)));
});

test('a grid: one column on a narrow tile, side by side on a strip', () => {
  assert.deepEqual(gridFor(156, 148, 3, 8), { cols: 1, rows: 3 });
  assert.deepEqual(gridFor(172, 320, 3, 8), { cols: 1, rows: 3 });
  assert.deepEqual(gridFor(1920, 462, 3, 20), { cols: 3, rows: 1 });
  assert.deepEqual(gridFor(480, 240, 1, 8), { cols: 1, rows: 1 });
});

test('doors: open first with how long, "All closed" when none is; urgent only when left open', () => {
  const t = paint(doors, demoData(now, 'es'), [480, 240], 'es').map((x) => x.text);
  assert.deepEqual(t.slice(0, 2), ['4 min', 'Puerta del jardín']);
  assert.ok(t.includes('Cerrada'));
  assert.match(paint(doors, calm('es'), [320, 110], 'es').map((x) => x.text).join(' '), /Todo cerrado/);
  assert.match(paint(doors, calm('zh-Hant'), [320, 110], 'zh-Hant').map((x) => x.text).join(' '), /全部關好/);
  const d = demoData(now, 'en');
  const options = { devices: [], rows: 0 };
  assert.equal(widgetState(doors, 'urgent', { sources: { [SOURCE]: d }, options, now } as never), false);
  const left = { ...d, devices: d.devices.map((x) => (x.open ? { ...x, openSince: now - 25 * 60_000 } : x)) };
  assert.equal(widgetState(doors, 'urgent', { sources: { [SOURCE]: left }, options, now } as never), true);
  assert.equal(widgetState(doors, 'idle', { sources: { [SOURCE]: calm('en') }, options } as never), true);
  const order = sortDoors([...d.devices].reverse().filter((x) => x.kind === 'contact')).map((x) => x.name);
  assert.equal(order[0], 'Garden door');
});

test('presence: who is moving now first, then when each saw someone', () => {
  const t = paint(presence, demoData(now, 'en'), [480, 240], 'en').map((x) => x.text);
  assert.ok(t.includes('Now') && t.includes('Now · 25 min') && t.includes('12 min ago'), t.join(' | '));
});

test('batteries: the low ones, or "Batteries OK" with the lowest', () => {
  assert.deepEqual(paint(batteries, demoData(now, 'es'), [320, 110], 'es').map((x) => x.text), ['8 %', 'Ventana del baño']);
  assert.match(paint(batteries, calm('en'), [320, 110], 'en').map((x) => x.text).join(' '), /Batteries OK.*Lowest: Entrance 54%/);
  assert.equal(widgetState(batteries, 'urgent', { sources: { [SOURCE]: demoData(now, 'en') } } as never), true);
});

test('no data yet, nothing heard, Bluetooth off: each says so', () => {
  assert.match(paint(climate, undefined, [320, 110], 'en').map((x) => x.text).join(' '), /Listening/);
  const off: SwitchBotData = { ...demoData(now, 'en'), devices: [], status: { reader: 'bluez', state: 'off', message: 'Bluetooth is off' } };
  assert.match(paint(doors, off, [480, 240], 'en').map((x) => x.text).join(' '), /Bluetooth is off/);
});
