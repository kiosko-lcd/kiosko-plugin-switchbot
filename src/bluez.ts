/**
 * What BlueZ, Linux's Bluetooth daemon, has heard: one
 * org.freedesktop.DBus.ObjectManager.GetManagedObjects on org.bluez
 * (`a{oa{sa{sv}}}`), read with `busctl --json=short` (systemd 240 and
 * later), which writes every D-Bus value as `{"type": "<signature>", "data": …}`
 * (busctl(1), --json). Pure functions: readers.ts runs the commands.
 *
 * - org.bluez.Device1 (https://github.com/bluez/bluez/blob/master/doc/org.bluez.Device.rst):
 *   `Address`, `Adapter`, `RSSI` (only while the device is being heard in a
 *   discovery: BlueZ drops it when discovery stops), `ManufacturerData`
 *   (`a{qv}`, company id → bytes) and `ServiceData` (`a{sv}`, UUID → bytes),
 *   the latest of each the adapter heard, advertisement and scan response
 *   merged.
 * - org.bluez.MediaTransport1 (doc/org.bluez.MediaTransport.rst): `State`
 *   is `active` while audio is streaming to (or from) a Bluetooth device.
 */
import { COMPANY_IDS, SERVICE_UUIDS } from './decode.ts';
import type { Advert } from './types.ts';

type Variant = { type: string; data: unknown };
type Props = Record<string, Variant>;
export type ManagedObjects = Record<string, Record<string, Props>>;

/** The `data` of a busctl --json reply, its first (or only) out argument. */
export function busctlData(json: string): unknown {
  const v = JSON.parse(json) as Variant;
  return Array.isArray(v.data) ? v.data[0] : v.data;
}

export function parseManagedObjects(json: string): ManagedObjects {
  const d = busctlData(json);
  return d && typeof d === 'object' ? (d as ManagedObjects) : {};
}

const bytesOf = (v: unknown): number[] | undefined => {
  const d = (v as Variant | undefined)?.data;
  return Array.isArray(d) && d.every((b) => typeof b === 'number') ? (d as number[]) : undefined;
};

/** Manufacturer data of SwitchBot's company id (0x0969, or 0x0059 on old firmware). */
function switchbotMd(dev: Props): number[] | undefined {
  const all = dev.ManufacturerData?.data as Record<string, Variant> | undefined;
  if (!all || typeof all !== 'object') return undefined;
  for (const id of COMPANY_IDS) {
    const b = bytesOf(all[String(id)]);
    if (b?.length) return b;
  }
  return undefined;
}

function switchbotSd(dev: Props): number[] | undefined {
  const all = dev.ServiceData?.data as Record<string, Variant> | undefined;
  if (!all || typeof all !== 'object') return undefined;
  for (const uuid of SERVICE_UUIDS) {
    const key = Object.keys(all).find((k) => k.toLowerCase() === uuid);
    const b = key ? bytesOf(all[key]) : undefined;
    if (b?.length) return b;
  }
  return undefined;
}

export interface Heard {
  adverts: Advert[];
  /** Every device object BlueZ has, SwitchBot or not (for the status line). */
  devices: number;
}

/**
 * The SwitchBot devices in a GetManagedObjects reply. Only those with an
 * `RSSI` count as heard now (`onlyHeard`): the others are what BlueZ still
 * keeps from an earlier discovery, possibly hours old.
 */
export function switchbotAdverts(objects: ManagedObjects, at: number, o: { onlyHeard?: boolean; adapter?: string } = {}): Heard {
  const adverts: Advert[] = [];
  let devices = 0;
  for (const [path, ifaces] of Object.entries(objects)) {
    const dev = ifaces['org.bluez.Device1'];
    if (!dev) continue;
    if (o.adapter && !path.startsWith(`${o.adapter}/`)) continue;
    devices++;
    const md = switchbotMd(dev);
    const sd = switchbotSd(dev);
    if (!md && !sd) continue;
    const rssi = typeof dev.RSSI?.data === 'number' ? (dev.RSSI.data as number) : undefined;
    if (o.onlyHeard !== false && rssi === undefined) continue;
    const address = typeof dev.Address?.data === 'string' ? (dev.Address.data as string).toUpperCase() : undefined;
    if (!address) continue;
    const a: Advert = { address, at };
    if (md) a.md = md;
    if (sd) a.sd = sd;
    if (rssi !== undefined) a.rssi = rssi;
    adverts.push(a);
  }
  return { adverts, devices };
}

/** Whether Bluetooth audio is streaming now: a MediaTransport1 whose State is `active`. */
export function audioPlaying(objects: ManagedObjects): boolean {
  return Object.values(objects).some((ifaces) => ifaces['org.bluez.MediaTransport1']?.State?.data === 'active');
}

/** The adapters (`/org/bluez/hci0`…) and whether each is powered. */
export function adapters(objects: ManagedObjects): { path: string; powered: boolean; discovering: boolean }[] {
  return Object.entries(objects)
    .filter(([, i]) => i['org.bluez.Adapter1'])
    .map(([path, i]) => ({ path, powered: i['org.bluez.Adapter1']!.Powered?.data === true, discovering: i['org.bluez.Adapter1']!.Discovering?.data === true }));
}
