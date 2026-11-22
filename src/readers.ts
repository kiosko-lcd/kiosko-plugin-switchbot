/**
 * The readers: they listen to what SwitchBot devices broadcast and hand the
 * raw advertisements to the decoder. They never pair, connect or write to a
 * device, and never change the adapter (no power, pairable or discoverable
 * changes): an adapter that is off stays off and says so.
 *
 * Linux (BlueZ), no native code:
 * - A scan window: `bluetoothctl --agent off` (BlueZ's own client, so no
 *   agent is registered) holds a discovery session with the filter
 *   `transport le` (Bluetooth Low Energy only: no classic inquiry, the part
 *   of a scan that hurts audio most) and `duplicate-data on` (every
 *   advertisement, not only the first), then `scan on`; `scan off` when the
 *   window ends. A discovery is active scanning: it also gets the scan
 *   responses, where SwitchBot puts the device type and the battery. A
 *   discovery belongs to the D-Bus client that started it, which is why it
 *   is held by a process that stays for the window rather than one
 *   `busctl call` (BlueZ ends it when its client goes).
 * - While the window is open, `busctl --json=short --system call org.bluez /
 *   org.freedesktop.DBus.ObjectManager GetManagedObjects` every couple of
 *   seconds: BlueZ keeps the latest manufacturer and service data of each
 *   device heard, and its RSSI while it is being heard.
 * - Passive listening would be lighter still, but BlueZ offers it to
 *   unprivileged clients only through org.bluez.AdvertisementMonitorManager1,
 *   which needs bluetoothd started with --experimental: when there is none,
 *   short windows with long pauses (the source's interval) keep the radio
 *   free most of the time.
 * - While Bluetooth audio is streaming (a MediaTransport1 `active`), the
 *   window is shortened or skipped, as the source's `whileAudio` says.
 *
 * Windows (WinRT's BluetoothLEAdvertisementWatcher) and macOS (CoreBluetooth)
 * are not written yet: their readers say so. The decoder and everything
 * after it does not depend on how the bytes were heard.
 */
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { adapters, audioPlaying, parseManagedObjects, switchbotAdverts, type ManagedObjects } from './bluez.ts';
import type { Advert, ReaderStatus } from './types.ts';

/** Runs a program and gives its standard output; throws when it is missing (`code: 'ENOENT'`) or fails. */
export type Run = (cmd: string, args: string[], o: { signal: AbortSignal; timeoutMs: number }) => Promise<string>;

/** A program kept running for a while, fed lines on its standard input. */
export interface Held {
  write(line: string): void;
  /** Ends it: closes its input, then SIGTERM if it is still there after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
  /** Rejects when the program could not start (missing). */
  started: Promise<void>;
}
export type Hold = (cmd: string, args: string[], o: { signal: AbortSignal }) => Held;

export interface Env {
  run: Run;
  hold: Hold;
  platform: NodeJS.Platform;
  signal: AbortSignal;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type WhileAudio = 'normal' | 'short' | 'pause';

export interface ScanPlan {
  /** How long a window listens. */
  listenMs: number;
  /** How often BlueZ is asked during it. */
  pollMs: number;
  whileAudio: WhileAudio;
  /** The window while audio plays, with `short`. */
  shortMs: number;
}

export interface ScanResult {
  adverts: Advert[];
  status: ReaderStatus;
}

/** The real `Run`: execFile with the C locale, no shell. */
export const execRun: Run = (cmd, args, { signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        e.stderr = String(stderr ?? '');
        reject(e);
      } else resolve(String(stdout));
    });
  });

/** The real `Hold`: spawn with a pipe for standard input; its output is not read. */
export const spawnHold: Hold = (cmd, args, { signal }) => {
  const child = nodeSpawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  started.catch(() => {});
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  signal.addEventListener('abort', kill, { once: true });
  return {
    started,
    write(line) {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(`${line}\n`);
    },
    async stop(graceMs = 2000) {
      signal.removeEventListener('abort', kill);
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
      child.stdin?.end();
      const timer = setTimeout(kill, graceMs);
      await exited;
      clearTimeout(timer);
    },
  };
};

export const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const message = (err: unknown) => {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr?.trim() || e?.message || String(err)).split('\n')[0]!.slice(0, 200);
};

const same = (a: number[] | undefined, b: number[] | undefined) => (a ?? []).join(',') === (b ?? []).join(',');

/**
 * Merges what each poll heard: a device keeps the time it was first heard
 * with these bytes, so the same advertisement seen in five polls is one.
 */
export function mergeHeard(into: Map<string, Advert>, heard: Advert[]): void {
  for (const a of heard) {
    const prev = into.get(a.address);
    if (!prev || !same(prev.md, a.md) || !same(prev.sd, a.sd)) into.set(a.address, a);
    else if (a.rssi !== undefined) prev.rssi = a.rssi;
  }
}

/** The commands fed to bluetoothctl for a window: an LE-only discovery that reports every advertisement. */
export const SCAN_ON = ['menu scan', 'transport le', 'duplicate-data on', 'back', 'scan on'];
export const SCAN_OFF = ['scan off', 'quit'];

export async function scanBluez(env: Env, plan: ScanPlan): Promise<ScanResult> {
  const gmo = async (): Promise<ManagedObjects> => parseManagedObjects(await env.run('busctl', ['--json=short', '--system', 'call', 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects'], { signal: env.signal, timeoutMs: 10_000 }));
  let first: ManagedObjects;
  try {
    first = await gmo();
  } catch (err) {
    const e = err as { code?: unknown; stderr?: string; message?: string };
    const absent = e?.code === 'ENOENT' || /ServiceUnknown|was not provided by any|not activatable|Failed to connect to bus|No such file/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`);
    return { adverts: [], status: { reader: 'bluez', state: absent ? 'off' : 'error', message: absent ? 'BlueZ is not running on this system' : message(err), scan: 'none' } };
  }
  const ads = adapters(first);
  if (!ads.length) return { adverts: [], status: { reader: 'bluez', state: 'off', message: 'no Bluetooth adapter', scan: 'none' } };
  if (!ads.some((a) => a.powered)) return { adverts: [], status: { reader: 'bluez', state: 'off', message: 'Bluetooth is off', scan: 'none' } };

  const heard = new Map<string, Advert>();
  mergeHeard(heard, switchbotAdverts(first, env.now()).adverts);
  const audio = audioPlaying(first);
  const mode: ReaderStatus['scan'] = !audio || plan.whileAudio === 'normal' ? 'normal' : plan.whileAudio === 'pause' ? 'paused' : 'short';
  if (mode === 'paused') return { adverts: [...heard.values()], status: { reader: 'bluez', state: 'ok', scan: 'paused', heard: heard.size, message: 'Bluetooth audio is playing: not scanning' } };

  const listenMs = mode === 'short' ? Math.min(plan.listenMs, plan.shortMs) : plan.listenMs;
  const held = env.hold('bluetoothctl', ['--agent', 'off'], { signal: env.signal });
  let warning: string | undefined;
  let scanning = false;
  try {
    await held.started;
    for (const line of SCAN_ON) held.write(line);
    scanning = true;
  } catch (err) {
    warning = (err as { code?: unknown }).code === 'ENOENT' ? 'bluetoothctl not found: only what other apps scan is heard' : message(err);
  }
  try {
    const start = env.now();
    // Bounded by count as well as by time, so a clock that doesn't move can't keep it here.
    for (let polls = Math.ceil(listenMs / plan.pollMs); polls > 0 && !env.signal.aborted && env.now() - start < listenMs; polls--) {
      await env.sleep(Math.min(plan.pollMs, listenMs - (env.now() - start)), env.signal);
      if (env.signal.aborted) break;
      try {
        mergeHeard(heard, switchbotAdverts(await gmo(), env.now()).adverts);
      } catch (err) {
        warning = message(err);
      }
    }
  } finally {
    if (scanning) for (const line of SCAN_OFF) held.write(line);
    await held.stop();
  }
  const status: ReaderStatus = { reader: 'bluez', state: 'ok', scan: mode, heard: heard.size };
  if (warning) status.message = warning;
  return { adverts: [...heard.values()], status };
}

const notYet = (reader: string): ScanResult => ({ adverts: [], status: { reader, state: 'off', message: 'not written yet for this system', scan: 'none' } });

/** The reader of each system. */
export async function scan(env: Env, plan: ScanPlan): Promise<ScanResult> {
  if (env.platform === 'linux') return scanBluez(env, plan);
  if (env.platform === 'win32') return notYet('windows');
  if (env.platform === 'darwin') return notYet('macos');
  return notYet(env.platform);
}
