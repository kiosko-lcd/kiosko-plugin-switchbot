import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceAlerts } from '@kiosko/sdk/testing';
import { audioPlaying, parseManagedObjects, switchbotAdverts } from './bluez.ts';
import { SCAN_OFF, SCAN_ON, mergeHeard, scan, type Env, type Held } from './readers.ts';
import { devicesSource, doorAlerts, readSwitchBot, type Options, type StateFile } from './source.ts';
import { emptyStore, type Store } from './state.ts';
import type { Advert, SwitchBotData } from './types.ts';

const FIXTURE = readFileSync(new URL('./fixtures/bluez-scan.json', import.meta.url), 'utf8');
const T0 = Date.parse('2026-11-23T10:00:00Z');
const MIN = 60_000;

const OPTIONS: Options = {
  devices: [],
  names: {},
  openWarnMs: 0,
  openAlertMs: 10 * MIN,
  showAlerts: true,
  alertDoors: [],
  batteryWarn: 20,
  batteryAlert: 10,
  units: 'auto',
  staleMs: 15 * MIN,
  listenMs: 10_000,
  whileAudio: 'short',
};

/** A fake machine: busctl answers `gmo()`, bluetoothctl records what it is told, time moves only when slept. */
function fakeEnv(gmo: () => string, o: { noBluetoothctl?: boolean; at?: number } = {}) {
  let now = o.at ?? T0;
  const calls: string[][] = [];
  const lines: string[] = [];
  let stopped = 0;
  const env: Partial<Env> = {
    platform: 'linux',
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return gmo();
    },
    hold: (cmd, args): Held => {
      calls.push([cmd, ...args]);
      const started = o.noBluetoothctl ? Promise.reject(Object.assign(new Error('spawn bluetoothctl ENOENT'), { code: 'ENOENT' })) : Promise.resolve();
      started.catch(() => {});
      return { started, write: (l) => lines.push(l), stop: async () => void stopped++ };
    },
  };
  return { env, calls, lines, stopped: () => stopped, now: () => now };
}

const memoryState = (): StateFile & { saved: number } => {
  let s: Store = emptyStore();
  const f = {
    saved: 0,
    load: async () => s,
    save: async (next: Store, _now: number, urgent: boolean) => {
      s = next;
      if (urgent) f.saved++;
    },
  };
  return f;
};

test('the BlueZ fixture: four SwitchBot devices heard, the neighbour skipped, no audio playing', () => {
  const objects = parseManagedObjects(FIXTURE);
  const { adverts, devices } = switchbotAdverts(objects, T0);
  assert.equal(devices, 5);
  assert.deepEqual(adverts.map((a) => a.address).sort(), ['C1:8A:64:22:62:97', 'C7:6B:06:06:2C:25', 'C8:6B:82:06:38:79', 'C8:6B:82:06:69:6B']);
  assert.deepEqual(adverts.find((a) => a.address === 'C8:6B:82:06:38:79')?.sd, undefined);
  assert.equal(audioPlaying(objects), false);
  // A device BlueZ remembers but isn't hearing now (no RSSI) doesn't count.
  const old = JSON.parse(FIXTURE);
  delete old.data[0]['/org/bluez/hci0/dev_C7_6B_06_06_2C_25']['org.bluez.Device1'].RSSI;
  assert.equal(switchbotAdverts(parseManagedObjects(JSON.stringify(old)), T0).adverts.length, 3);
});

test('a window: an LE-only discovery held by bluetoothctl with no agent, BlueZ asked every pollMs, then scan off; nothing else is sent', async () => {
  const f = fakeEnv(() => FIXTURE);
  const ac = new AbortController();
  const r = await scan({ ...(f.env as Env), signal: ac.signal }, { listenMs: 10_000, pollMs: 2000, whileAudio: 'short', shortMs: 3000 });
  assert.equal(r.status.state, 'ok');
  assert.equal(r.status.scan, 'normal');
  assert.equal(r.adverts.length, 4);
  assert.deepEqual(f.lines, [...SCAN_ON, ...SCAN_OFF]);
  assert.deepEqual(SCAN_ON, ['menu scan', 'transport le', 'duplicate-data on', 'back', 'scan on']);
  const held = f.calls.filter((c) => c[0] === 'bluetoothctl');
  assert.deepEqual(held, [['bluetoothctl', '--agent', 'off']]);
  const busctl = f.calls.filter((c) => c[0] === 'busctl');
  assert.equal(busctl.length, 6); // before, then every 2 s for 10 s (pollMs given here)
  assert.ok(busctl.every((c) => c.includes('GetManagedObjects')));
  // Never: pair, connect, trust, power, pairable, discoverable, remove.
  assert.ok(![...f.lines, ...f.calls.flat()].some((l) => /\b(pair|connect|trust|power|pairable|discoverable|remove|write)\b/i.test(l)));
  assert.equal(f.stopped(), 1);
});

test('while Bluetooth audio plays: a 3 s window, or none', async () => {
  const playing = JSON.parse(FIXTURE);
  playing.data[0]['/org/bluez/hci0/dev_6C_D3_EE_00_00_01/sep1/fd0'] = { 'org.bluez.MediaTransport1': { State: { type: 's', data: 'active' } } };
  const json = JSON.stringify(playing);
  const short = fakeEnv(() => json);
  const r = await scan({ ...(short.env as Env), signal: new AbortController().signal }, { listenMs: 10_000, pollMs: 1000, whileAudio: 'short', shortMs: 3000 });
  assert.equal(r.status.scan, 'short');
  assert.equal(short.now() - T0, 3000);
  const pause = fakeEnv(() => json);
  const p = await scan({ ...(pause.env as Env), signal: new AbortController().signal }, { listenMs: 10_000, pollMs: 1000, whileAudio: 'pause', shortMs: 3000 });
  assert.equal(p.status.scan, 'paused');
  assert.deepEqual(pause.lines, []);
  assert.equal(p.adverts.length, 4); // what BlueZ hears for other apps still counts
});

test('Bluetooth off, no adapter, no BlueZ, no bluetoothctl: said, never changed', async () => {
  const off = JSON.parse(FIXTURE);
  off.data[0]['/org/bluez/hci0']['org.bluez.Adapter1'].Powered.data = false;
  const f = fakeEnv(() => JSON.stringify(off));
  const r = await scan({ ...(f.env as Env), signal: new AbortController().signal }, { listenMs: 10_000, pollMs: 2000, whileAudio: 'short', shortMs: 3000 });
  assert.deepEqual([r.status.state, r.status.message], ['off', 'Bluetooth is off']);
  assert.deepEqual(f.lines, []);
  const none = fakeEnv(() => JSON.stringify({ type: 'a{oa{sa{sv}}}', data: [{}] }));
  assert.equal((await scan({ ...(none.env as Env), signal: new AbortController().signal }, { listenMs: 1, pollMs: 1, whileAudio: 'short', shortMs: 1 })).status.message, 'no Bluetooth adapter');
  const noBluez = fakeEnv(() => {
    throw Object.assign(new Error('Call failed'), { stderr: 'Call failed: The name org.bluez was not provided by any .service files' });
  });
  assert.equal((await scan({ ...(noBluez.env as Env), signal: new AbortController().signal }, { listenMs: 1, pollMs: 1, whileAudio: 'short', shortMs: 1 })).status.state, 'off');
  const noCtl = fakeEnv(() => FIXTURE, { noBluetoothctl: true });
  const r2 = await scan({ ...(noCtl.env as Env), signal: new AbortController().signal }, { listenMs: 4000, pollMs: 2000, whileAudio: 'short', shortMs: 3000 });
  assert.match(r2.status.message!, /bluetoothctl not found/);
  assert.deepEqual(noCtl.lines, []);
  const win = await scan({ ...(fakeEnv(() => FIXTURE).env as Env), platform: 'win32', signal: new AbortController().signal }, { listenMs: 1, pollMs: 1, whileAudio: 'short', shortMs: 1 });
  assert.deepEqual([win.status.reader, win.status.state], ['windows', 'off']);
});

test('the same advertisement in several polls is heard once, at its first time', () => {
  const m = new Map<string, Advert>();
  mergeHeard(m, [{ address: 'A', at: 1, md: [1, 2], rssi: -60 }]);
  mergeHeard(m, [{ address: 'A', at: 2, md: [1, 2], rssi: -70 }]);
  assert.deepEqual([m.get('A')!.at, m.get('A')!.rssi], [1, -70]);
  mergeHeard(m, [{ address: 'A', at: 3, md: [1, 3] }]);
  assert.equal(m.get('A')!.at, 3);
});

test('a read: decoded devices from the fixture, thermometers first, with the outdoor meter in °F as its screen shows', async () => {
  const f = fakeEnv(() => FIXTURE);
  const state = memoryState();
  const data = await readSwitchBot(OPTIONS, { now: T0, signal: new AbortController().signal }, { env: f.env, state });
  const byKey = Object.fromEntries(data.devices.map((d) => [d.key, d]));
  assert.deepEqual([byKey['C7:6B:06:06:2C:25']!.temperature, byKey['C7:6B:06:06:2C:25']!.fahrenheit, byKey['C7:6B:06:06:2C:25']!.battery], [13.1, true, 64]);
  assert.equal(byKey['C8:6B:82:06:69:6B']!.temperature, 19.2);
  assert.equal(byKey['C1:8A:64:22:62:97']!.kind, 'other');
  assert.equal(byKey['C8:6B:82:06:38:79']!.model, 'unknown'); // no scan response heard yet
  assert.equal(data.devices[0]!.kind, 'climate');
  assert.equal(state.saved, 1); // models learnt: written now
});

test('a read with the usual 10 s window starts busctl twice (before and at the end), not every 2 s', async () => {
  // What the devices said changes mid-window: the end of it is what counts.
  let polls = 0;
  const later = JSON.parse(FIXTURE);
  delete later.data[0]['/org/bluez/hci0/dev_C7_6B_06_06_2C_25'];
  const f = fakeEnv(() => (polls++ === 0 ? JSON.stringify(later) : FIXTURE));
  const data = await readSwitchBot(OPTIONS, { now: T0, signal: new AbortController().signal }, { env: f.env, state: memoryState() });
  assert.equal(OPTIONS.listenMs, 10_000);
  assert.deepEqual(f.calls.map((c) => c[0]), ['busctl', 'bluetoothctl', 'busctl']);
  assert.equal(f.now() - T0, 10_000, 'it still listens the whole window');
  assert.ok(data.devices.some((d) => d.key === 'C7:6B:06:06:2C:25'), 'a device first heard during the window counts');
  // A long window is still asked every 10 s.
  const long = fakeEnv(() => FIXTURE);
  await readSwitchBot({ ...OPTIONS, listenMs: 30_000 }, { now: T0, signal: new AbortController().signal }, { env: long.env, state: memoryState() });
  assert.equal(long.calls.filter((c) => c[0] === 'busctl').length, 4);
});

/* Alerts */

const openDoor = (since: number, extra: Partial<SwitchBotData['devices'][0]> = {}): SwitchBotData => ({
  at: T0,
  devices: [{ key: 'CB:39:CD:C4:3D:46', name: 'Garden door', model: 'contact', modelName: 'Contact Sensor', kind: 'contact', open: true, openSince: since, lastSeen: T0, stale: false, ...extra }],
  status: { reader: 'bluez', state: 'ok' },
  openWarnMs: 0,
  openAlertMs: 10 * MIN,
  batteryWarn: 20,
  batteryAlert: 10,
  fullScreen: true,
  alertDoors: [],
  units: 'auto',
});

test('a door left open alerts once per time it is left open, past the threshold, if wanted', () => {
  assert.deepEqual(doorAlerts(openDoor(T0 - 9 * MIN), undefined, T0), []);
  const [a] = doorAlerts(openDoor(T0 - 12 * MIN), undefined, T0);
  assert.equal(a!.id, `door-CB:39:CD:C4:3D:46@${T0 - 12 * MIN}`);
  assert.equal(a!.icon, 'door-open');
  assert.equal(a!.level, 'warn');
  assert.deepEqual((a!.title as Record<string, string>).es, 'Garden door: abierta');
  assert.match((a!.text as Record<string, string>).en!, /^Open for 12 min · since /);
  // Later in the same episode: the same id (so "Seen" keeps it hidden).
  assert.equal(doorAlerts(openDoor(T0 - 12 * MIN), undefined, T0 + 30 * MIN)[0]!.id, a!.id);
  assert.match((doorAlerts(openDoor(T0 - 12 * MIN), undefined, T0 + 60 * MIN)[0]!.text as Record<string, string>).en!, /1 h 12/);
  // Closed, stale, off, or a door left out: nothing.
  assert.deepEqual(doorAlerts(openDoor(T0 - 12 * MIN, { open: false }), undefined, T0), []);
  assert.deepEqual(doorAlerts(openDoor(T0 - 12 * MIN, { stale: true }), undefined, T0), []);
  assert.deepEqual(doorAlerts({ ...openDoor(T0 - 12 * MIN), fullScreen: false }, undefined, T0), []);
  assert.deepEqual(doorAlerts(openDoor(T0 - 12 * MIN), { alertDoors: ['!Garden*'] }, T0), []);
  assert.equal(doorAlerts(openDoor(T0 - 12 * MIN), { alertDoors: ['Garden door'] }, T0).length, 1);
});

test('the source asks for alerts the way Kiosko does; the demo has none (its door is open 4 minutes)', () => {
  assert.equal(sourceAlerts(devicesSource, { data: openDoor(T0 - 12 * MIN), options: OPTIONS, now: T0 }).length, 1);
  assert.deepEqual(sourceAlerts(devicesSource, { options: OPTIONS, now: T0 }), []);
});

test('reading a door twice across a close: one alert id, then a new one', async () => {
  const DOOR = 'CB:39:CD:C4:3D:46';
  const gmoWith = (sd: number[]) =>
    JSON.stringify({
      type: 'a{oa{sa{sv}}}',
      data: [{
        '/org/bluez/hci0': { 'org.bluez.Adapter1': { Powered: { type: 'b', data: true } } },
        '/org/bluez/hci0/dev_CB_39_CD_C4_3D_46': { 'org.bluez.Device1': { Address: { type: 's', data: DOOR }, RSSI: { type: 'n', data: -60 }, ServiceData: { type: 'a{sv}', data: { '0000fd3d-0000-1000-8000-00805f9b34fb': { type: 'ay', data: sd } } } } },
      }],
    });
  const state = memoryState();
  const read = async (sd: number[], now: number) => {
    const f = fakeEnv(() => gmoWith(sd), { at: now });
    return readSwitchBot({ ...OPTIONS, listenMs: 2000 }, { now, signal: new AbortController().signal }, { env: f.env, state });
  };
  const open = (ageS: number) => [0x64, 0, 0x5a, 0x02, 0, 5, (ageS >> 8) & 0xff, ageS & 0xff, 0x41];
  const closed = (ageS: number) => [0x64, 0, 0x5a, 0x00, 0, 5, (ageS >> 8) & 0xff, ageS & 0xff, 0x41];
  const d1 = await read(open(660), T0);
  const ids1 = doorAlerts(d1, OPTIONS, T0).map((a) => a.id);
  const d2 = await read(open(720), T0 + MIN);
  assert.deepEqual(doorAlerts(d2, OPTIONS, T0 + MIN).map((a) => a.id), ids1);
  assert.equal(ids1.length, 1);
  await read(closed(10), T0 + 2 * MIN);
  const d4 = await read(open(700), T0 + 15 * MIN);
  const ids4 = doorAlerts(d4, OPTIONS, T0 + 15 * MIN).map((a) => a.id);
  assert.equal(ids4.length, 1);
  assert.notDeepEqual(ids4, ids1);
});

test('naming devices: every address offered with what it said last and when', async () => {
  const { demoData } = await import('./demo.ts');
  const { readingLabel } = await import('./source.ts');
  const { localize } = await import('@kiosko/sdk/i18n');
  const now = Date.now();
  const data = demoData(now, 'es');
  const tr = (x: Parameters<typeof localize>[0]) => localize(x, 'es');
  const choices = devicesSource.choices!.addresses!(data, { locale: 'es', t: tr } as never);
  assert.equal(choices.length, data.devices.length);
  assert.deepEqual(choices.map((c) => c.value), data.devices.map((d) => d.key));
  const climate = data.devices.find((d) => d.temperature !== undefined)!;
  const label = readingLabel({ ...climate, temperature: 22.14, humidity: 49.4, fahrenheit: false, lastSeen: now - 60_000 }, { ...data, units: 'auto' }, 'es', tr, now);
  assert.match(label, /22,1°C 49 %/);
  assert.match(label, /hace 1 minuto/);
  const door = data.devices.find((d) => d.kind === 'contact');
  if (door) assert.match(readingLabel({ ...door, open: false, lastSeen: now }, data, 'es', tr, now), /cerrada · .*ahora/);
});
