/**
 * Sample data for the gallery, the editor and the tests: a believable home
 * (living room, bedroom and outside thermometers, the garden door open for
 * four minutes, someone in the hallway, a window sensor running low) with the
 * names people there would give them.
 */
import { HISTORY_STEP_MS } from './state.ts';
import type { Device, History, SwitchBotData } from './types.ts';

type Names = Record<'living' | 'bedroom' | 'outside' | 'garden' | 'front' | 'window' | 'hall' | 'entry' | 'study', string>;

const NAMES: Record<string, Names> = {
  en: { living: 'Living room', bedroom: 'Bedroom', outside: 'Outside', garden: 'Garden door', front: 'Front door', window: 'Bathroom window', hall: 'Hallway', entry: 'Entrance', study: 'Study' },
  es: { living: 'Salón', bedroom: 'Dormitorio', outside: 'Exterior', garden: 'Puerta del jardín', front: 'Puerta de entrada', window: 'Ventana del baño', hall: 'Pasillo', entry: 'Entrada', study: 'Despacho' },
  de: { living: 'Wohnzimmer', bedroom: 'Schlafzimmer', outside: 'Draußen', garden: 'Gartentür', front: 'Haustür', window: 'Badfenster', hall: 'Flur', entry: 'Eingang', study: 'Arbeitszimmer' },
  'zh-Hans': { living: '客厅', bedroom: '卧室', outside: '室外', garden: '花园门', front: '大门', window: '浴室窗', hall: '走廊', entry: '玄关', study: '书房' },
  'zh-Hant': { living: '客廳', bedroom: '臥室', outside: '室外', garden: '花園門', front: '大門', window: '浴室窗', hall: '走廊', entry: '玄關', study: '書房' },
};

/** The script of a locale tag: `zh-TW`, `zh-HK` and `zh-Hant` are Traditional; other `zh` Simplified. */
export function namesFor(locale: string): Names {
  const l = locale.toLowerCase();
  if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? NAMES['zh-Hant']! : NAMES['zh-Hans']!;
  return NAMES[l.split('-')[0]!] ?? NAMES.en!;
}

/** A day of readings ending at `now`: a gentle daily wave around `mid`, ending at `last`. */
function day(now: number, last: number, swing: number, hum: number, humSwing: number, seed: number): History {
  const n = (24 * 3600_000) / HISTORY_STEP_MS;
  const t0 = Math.floor(now / HISTORY_STEP_MS) * HISTORY_STEP_MS - (n - 1) * HISTORY_STEP_MS;
  const temp: (number | null)[] = [];
  const hums: (number | null)[] = [];
  const wave = (i: number) => Math.sin(((i - n + seed) / n) * Math.PI * 2) + 0.25 * Math.sin((i + seed * 7) / 9);
  const end = wave(n - 1);
  for (let i = 0; i < n; i++) {
    temp.push(Math.round((last + swing * (wave(i) - end)) * 10) / 10);
    hums.push(Math.round(hum - humSwing * (wave(i) - end)));
  }
  return { t0, stepMs: HISTORY_STEP_MS, temp, hum: hums };
}

export function demoData(now: number, locale: string): SwitchBotData {
  const n = namesFor(locale);
  const min = 60_000;
  const base = { stale: false, lastSeen: now - 20_000 };
  const devices: Device[] = [
    { ...base, key: 'C7:6B:06:06:05:55', name: n.living, model: 'meter-plus', modelName: 'Meter Plus', kind: 'climate', temperature: 21.5, humidity: 52, battery: 88, rssi: -61, history: day(now, 21.5, 0.8, 52, 3, 4) },
    { ...base, key: 'C8:6B:82:06:69:6B', name: n.bedroom, model: 'meter', modelName: 'Meter', kind: 'climate', temperature: 19.8, humidity: 58, battery: 71, rssi: -70, history: day(now, 19.8, 0.6, 58, 4, 10) },
    { ...base, key: 'C7:6B:06:06:2C:25', name: n.outside, model: 'outdoor-meter', modelName: 'Indoor/Outdoor Thermo-Hygrometer', kind: 'climate', temperature: 8.4, humidity: 81, battery: 64, rssi: -82, history: day(now, 8.4, 3.5, 81, 9, 30) },
    { ...base, key: 'D4:1A:5C:30:11:02', name: n.garden, model: 'contact', modelName: 'Contact Sensor', kind: 'contact', open: true, openSince: now - 4 * min, battery: 93, light: true, rssi: -74 },
    { ...base, key: 'D4:1A:5C:30:11:03', name: n.front, model: 'contact', modelName: 'Contact Sensor', kind: 'contact', open: false, closedAt: now - 47 * min, battery: 80, rssi: -66 },
    { ...base, key: 'D4:1A:5C:30:11:04', name: n.window, model: 'contact', modelName: 'Contact Sensor', kind: 'contact', open: false, closedAt: now - 5 * 3600_000, battery: 8, rssi: -79 },
    { ...base, key: 'E2:7C:41:9A:20:01', name: n.hall, model: 'motion', modelName: 'Motion Sensor', kind: 'motion', motion: true, lastMotion: now - 10_000, battery: 76, light: false, rssi: -68 },
    { ...base, key: 'E2:7C:41:9A:20:02', name: n.entry, model: 'motion', modelName: 'Motion Sensor', kind: 'motion', motion: false, lastMotion: now - 12 * min, battery: 54, rssi: -71 },
    { ...base, key: 'B0:E9:FE:A9:EA:B1', name: n.study, model: 'presence', modelName: 'Presence Sensor', kind: 'presence', motion: true, presenceSince: now - 25 * min, lastMotion: now - 20_000, batteryRange: '>=60', battery: 100, rssi: -63 },
  ];
  return {
    at: now,
    devices,
    status: { reader: 'bluez', state: 'ok', scan: 'normal', heard: devices.length },
    openWarnMs: 0,
    openAlertMs: 10 * min,
    batteryWarn: 20,
    batteryAlert: 10,
    fullScreen: true,
    alertDoors: [],
    units: 'auto',
  };
}
