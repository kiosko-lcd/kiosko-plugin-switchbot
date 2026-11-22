/** What the plugin knows about each SwitchBot device, and what the source gives the widgets. */

/** What a device is for, which decides the widget that shows it. */
export type Kind = 'climate' | 'contact' | 'motion' | 'presence' | 'other';

/** One advertisement heard: the raw bytes, as a reader got them. */
export interface Advert {
  /** `AA:BB:CC:DD:EE:FF`. */
  address: string;
  /** Manufacturer data of company 0x0969 (Woan Technology), or of 0x0059 on old firmware, without the company id. */
  md?: number[];
  /** Service data of UUID 0xfd3d (or 0x0d00 on old firmware). */
  sd?: number[];
  rssi?: number;
  /** When it was heard (epoch ms). */
  at: number;
}

/** What one advertisement says, decoded (see decode.ts). Missing fields: not in this advertisement. */
export interface Decoded {
  /** Our model id (`meter`, `outdoor-meter`, `contact`…), or `unknown`. */
  model: string;
  /** SwitchBot's product name ("Indoor/Outdoor Thermo-Hygrometer"). */
  modelName: string;
  kind: Kind;
  /** The service data's first byte, bit 7: the payload is encrypted and is not read. */
  encrypted?: boolean;
  /** The device type byte (service data byte 0, bit 7 cleared) or the product id, in hex, for unknown ones. */
  type?: string;
  battery?: number;
  /** The presence sensor only says a range of its battery. */
  batteryRange?: '<10' | '10-19' | '20-59' | '>=60';
  temperature?: number;
  humidity?: number;
  /** The device's own screen shows °F. */
  fahrenheit?: boolean;
  co2?: number;
  /** Contact sensor: the door is open (or left open past the device's own timer). */
  open?: boolean;
  /** Contact sensor: open past the "left open" timer set in the SwitchBot app. */
  leftOpen?: boolean;
  /** Seconds since the contact last changed (opened or closed), from the contact sensor's service data. */
  contactAgeS?: number;
  motion?: boolean;
  /** Seconds since the PIR last fired (motion and contact sensors' service data). */
  motionAgeS?: number;
  /** Presence sensor: seconds the current state (someone / no one) has lasted. */
  presenceForS?: number;
  /** Bright (true) or dark (false), where the device says. */
  light?: boolean;
  /** Contact sensor's button: a counter that moves on each press (1–15). */
  buttonCount?: number;
}

/** One device, as the widgets get it. */
export interface Device {
  /** The Bluetooth address, `AA:BB:CC:DD:EE:FF`: the device's key. */
  key: string;
  /** The user's name for it, or "" (the widgets then use the model). */
  name: string;
  model: string;
  modelName: string;
  kind: Kind;
  encrypted?: boolean;
  type?: string;
  battery?: number;
  batteryRange?: Decoded['batteryRange'];
  temperature?: number;
  humidity?: number;
  fahrenheit?: boolean;
  co2?: number;
  open?: boolean;
  leftOpen?: boolean;
  /** When the door opened (the open episode, stable while it stays open). */
  openSince?: number;
  /** When the door last closed, when known. */
  closedAt?: number;
  motion?: boolean;
  /** When there was motion last (epoch ms). */
  lastMotion?: number;
  /** Presence sensor: since when the current state (someone / no one) holds. */
  presenceSince?: number;
  light?: boolean;
  buttonCount?: number;
  rssi?: number;
  /** When it was last heard (epoch ms). */
  lastSeen: number;
  /** Not heard for longer than the source's `staleMs`: its readings are old. */
  stale: boolean;
  /** Thermometers: the last hours, one value per bucket (null: not heard then). */
  history?: History;
}

export interface History {
  /** Start of the first bucket (epoch ms). */
  t0: number;
  stepMs: number;
  temp: (number | null)[];
  hum: (number | null)[];
}

export type ReaderState = 'ok' | 'off' | 'error';

/** How the last read went. */
export interface ReaderStatus {
  reader: string;
  state: ReaderState;
  message?: string;
  /** How it listened: a normal scan window, a short one (Bluetooth audio playing), none. */
  scan?: 'normal' | 'short' | 'paused' | 'none';
  /** SwitchBot devices heard in the last window. */
  heard?: number;
}

export interface SwitchBotData {
  at: number;
  devices: Device[];
  status: ReaderStatus;
  /** Doors open longer than this turn red (and alert). */
  openAlertMs: number;
  openWarnMs: number;
  batteryWarn: number;
  batteryAlert: number;
  /** Full-screen alerts for doors left open. */
  fullScreen: boolean;
  /** Keys of the doors that may raise one. */
  alertDoors: string[];
  units: 'auto' | 'celsius' | 'fahrenheit';
}
