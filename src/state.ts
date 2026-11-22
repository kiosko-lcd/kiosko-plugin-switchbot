/**
 * What the plugin remembers between reads (and restarts): the last state of
 * each device heard, the model of each address (an advertisement without its
 * scan response doesn't say), when each door opened, and the last hours of
 * each thermometer. Pure functions; source.ts keeps it in memory and in
 * `dataDir/state.json`.
 */
import { matchFilter } from '@kiosko/sdk';
import { decode } from './decode.ts';
import type { Advert, Decoded, Device, History, Kind } from './types.ts';

/** One bucket of a thermometer's history. */
export const HISTORY_STEP_MS = 5 * 60_000;
/** How much history is kept: a day. */
export const HISTORY_MS = 24 * 3600_000;
/** Devices not heard for this long are forgotten. */
export const FORGET_MS = 30 * 24 * 3600_000;
/** A door seen open again whose sensor says it opened this much later than the episode we have: it closed and opened again between two windows. */
export const REOPEN_MS = 90_000;

/** A device as remembered: everything but what depends on the user's options. */
export type Remembered = Omit<Device, 'name' | 'stale' | 'history'>;

export interface Store {
  v: 1;
  models: Record<string, string>;
  devices: Record<string, Remembered>;
  history: Record<string, History>;
}

export const emptyStore = (): Store => ({ v: 1, models: {}, devices: {}, history: {} });

/** A store read from disk, whatever it holds: anything unexpected is dropped. */
export function reviveStore(raw: unknown): Store {
  const s = raw as Partial<Store> | null;
  if (!s || s.v !== 1) return emptyStore();
  const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, never>) : {});
  return { v: 1, models: obj(s.models), devices: obj(s.devices), history: obj(s.history) };
}

/* History ----------------------------------------------------------------------------------- */

const bucketStart = (t: number) => Math.floor(t / HISTORY_STEP_MS) * HISTORY_STEP_MS;
const SLOTS = HISTORY_MS / HISTORY_STEP_MS;

/** Adds a reading to a thermometer's history: the latest one in each 5-minute bucket, a day of them. */
export function addSample(h: History | undefined, at: number, temp: number | undefined, hum: number | undefined): History {
  const start = bucketStart(at);
  let out: History = h && h.stepMs === HISTORY_STEP_MS ? { ...h, temp: [...h.temp], hum: [...h.hum] } : { t0: start, stepMs: HISTORY_STEP_MS, temp: [], hum: [] };
  let i = Math.round((start - out.t0) / HISTORY_STEP_MS);
  if (i < 0) return out; // older than what we have: a clock that went back
  while (out.temp.length < i) {
    out.temp.push(null);
    out.hum.push(null);
  }
  out.temp[i] = temp ?? out.temp[i] ?? null;
  out.hum[i] = hum ?? out.hum[i] ?? null;
  const extra = out.temp.length - SLOTS;
  if (extra > 0) out = { t0: out.t0 + extra * HISTORY_STEP_MS, stepMs: HISTORY_STEP_MS, temp: out.temp.slice(extra), hum: out.hum.slice(extra) };
  return out;
}

/** The last `ms` of a history, ending at `now` (empty buckets at the end when it wasn't heard lately). */
export function historyWindow(h: History | undefined, now: number, ms: number): History | undefined {
  if (!h) return undefined;
  const n = Math.max(1, Math.round(ms / h.stepMs));
  const end = Math.floor((bucketStart(now) - h.t0) / h.stepMs); // index of now's bucket
  const from = end - n + 1;
  const pick = (a: (number | null)[]) => Array.from({ length: n }, (_, k) => a[from + k] ?? null);
  return { t0: h.t0 + from * h.stepMs, stepMs: h.stepMs, temp: pick(h.temp), hum: pick(h.hum) };
}

/** Rising, falling or steady: the last reading against the one about an hour before. Null: not enough history. */
export function trendOf(h: History | undefined, opts: { spanMs?: number; minDelta?: number } = {}): 'up' | 'down' | 'flat' | null {
  if (!h) return null;
  const span = Math.round((opts.spanMs ?? 3600_000) / h.stepMs);
  let last = -1;
  for (let i = h.temp.length - 1; i >= 0; i--) if (h.temp[i] != null) {
    last = i;
    break;
  }
  if (last < 0) return null;
  // The reading closest to an hour before, within a quarter hour.
  for (let d = 0; d <= 3; d++) for (const j of [last - span + d, last - span - d]) {
    const v = h.temp[j];
    if (j >= 0 && j < last && v != null) {
      const delta = h.temp[last]! - v;
      const min = opts.minDelta ?? 0.3;
      return delta >= min ? 'up' : delta <= -min ? 'down' : 'flat';
    }
  }
  return null;
}

/* Applying advertisements ------------------------------------------------------------------- */

const READINGS = ['battery', 'batteryRange', 'temperature', 'humidity', 'fahrenheit', 'co2', 'light', 'buttonCount', 'leftOpen', 'motion'] as const;

function nextDevice(prev: Remembered | undefined, d: Decoded, a: Advert): Remembered {
  const at = a.at;
  const kept = prev && prev.model === d.model ? prev : undefined;
  const out: Remembered = { ...(kept ?? {}), key: a.address, model: d.model, modelName: d.modelName, kind: d.kind, lastSeen: at };
  if (d.type) out.type = d.type;
  if (d.encrypted) out.encrypted = true;
  else delete out.encrypted;
  if (a.rssi !== undefined) out.rssi = a.rssi;
  for (const k of READINGS) if (d[k] !== undefined) (out as Record<string, unknown>)[k] = d[k];
  if (d.kind === 'contact' && d.open !== undefined) {
    const changedAt = d.contactAgeS !== undefined ? at - d.contactAgeS * 1000 : undefined;
    if (d.open) {
      const was = kept?.open && kept.openSince !== undefined ? kept.openSince : undefined;
      // Still the same episode unless the sensor says it opened again after it.
      out.openSince = was !== undefined && !(changedAt !== undefined && changedAt > was + REOPEN_MS) ? was : (changedAt ?? at);
    } else {
      delete out.openSince;
      if (changedAt !== undefined) out.closedAt = changedAt;
      else if (kept?.open) out.closedAt = at;
    }
    out.open = d.open;
  }
  if (d.kind === 'presence' && d.motion !== undefined) {
    const since = d.presenceForS !== undefined ? at - d.presenceForS * 1000 : kept?.motion === d.motion ? kept.presenceSince : at;
    if (since !== undefined) out.presenceSince = since;
    // Someone there now; or no one since `since`, so the last presence ended then.
    const last = d.motion ? at : kept?.motion ? at : since;
    if (last !== undefined) out.lastMotion = Math.max(kept?.lastMotion ?? 0, last);
  } else if (d.motion !== undefined) {
    const last = d.motion ? at : d.motionAgeS !== undefined ? at - d.motionAgeS * 1000 : undefined;
    if (last !== undefined) out.lastMotion = Math.max(kept?.lastMotion ?? 0, last);
  }
  return out;
}

/** The store after these advertisements (the store given is not changed). */
export function applyAdverts(store: Store, adverts: Advert[]): Store {
  const next: Store = { v: 1, models: { ...store.models }, devices: { ...store.devices }, history: { ...store.history } };
  for (const a of [...adverts].sort((x, y) => x.at - y.at)) {
    const d = decode(a.sd, a.md, next.models[a.address]);
    if (!d) continue;
    if (d.model !== 'unknown') next.models[a.address] = d.model;
    const dev = nextDevice(next.devices[a.address], d, a);
    next.devices[a.address] = dev;
    if (d.kind === 'climate' && (d.temperature !== undefined || d.humidity !== undefined)) next.history[a.address] = addSample(next.history[a.address], a.at, d.temperature, d.humidity);
  }
  return next;
}

/** Forgets devices not heard for a month. */
export function forget(store: Store, now: number): Store {
  const keep = Object.entries(store.devices).filter(([, d]) => now - d.lastSeen < FORGET_MS);
  if (keep.length === Object.keys(store.devices).length) return store;
  const keys = new Set(keep.map(([k]) => k));
  const pick = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => keys.has(k)));
  return { v: 1, models: pick(store.models), devices: Object.fromEntries(keep), history: pick(store.history) };
}

/* What the widgets get ---------------------------------------------------------------------- */

/** `aa-bb_cc…` or `AABBCC…` as `AA:BB:CC:DD:EE:FF`, for the names the user wrote. */
export function normalizeAddress(s: string): string | undefined {
  const hex = s.replace(/[^0-9a-f]/gi, '');
  return hex.length === 12 ? hex.toUpperCase().match(/../g)!.join(':') : undefined;
}

const KIND_ORDER: Record<Kind, number> = { climate: 0, contact: 1, motion: 2, presence: 3, other: 4 };

export interface ViewOptions {
  devices: string[];
  names: Record<string, string>;
  staleMs: number;
}

/** The devices to show: named as the user wants, filtered, stale ones marked, with their history. */
export function viewOf(store: Store, now: number, o: ViewOptions): Device[] {
  const names = new Map<string, string>();
  for (const [k, v] of Object.entries(o.names ?? {})) {
    const addr = normalizeAddress(k);
    if (addr && v.trim()) names.set(addr, v.trim());
  }
  const out: Device[] = [];
  for (const r of Object.values(store.devices)) {
    const name = names.get(r.key) ?? '';
    if (!matchFilter([name, r.key, r.kind, r.model].filter(Boolean), o.devices)) continue;
    const d: Device = { ...r, name, stale: now - r.lastSeen > o.staleMs };
    const h = store.history[r.key];
    if (h && r.kind === 'climate') d.history = h;
    out.push(d);
  }
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.name || a.key).localeCompare(b.name || b.key));
}
