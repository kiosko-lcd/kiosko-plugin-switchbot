/**
 * What a SwitchBot advertisement says, from its bytes. Pure functions: the
 * readers (bluez.ts) hand them the manufacturer data and the service data
 * they heard, nothing is ever sent to a device.
 *
 * The byte layouts are those of pySwitchbot (https://github.com/sblibs/pySwitchbot,
 * MIT, © 2018 Daniel Høyer Iversen; the library Home Assistant's SwitchBot
 * integration uses), switchbot/adv_parser.py and switchbot/adv_parsers/*.py,
 * ported to TypeScript (see NOTICE), and of SwitchBot's own BLE documents
 * (https://github.com/OpenWonderLabs/SwitchBotAPI-BLE, README.md and
 * devicetypes/{meter,contactsensor,motionsensor}.md), cited where each byte
 * is read.
 *
 * In short: an advertisement (ADV_IND) carries manufacturer data of company
 * 0x0969 (Woan Technology; 0x0059 on old firmware) whose first six bytes are
 * the device's address and the rest its state; the scan response (SCAN_RSP,
 * only heard with an active scan) carries service data of UUID 0xfd3d
 * (0x0d00 on old firmware) whose byte 0 is the device type (bit 7: the
 * payload is encrypted) and the rest its state again, sometimes with more.
 * Newer products have no device type byte: they end their service data with
 * a 4-byte product id.
 */
import type { Decoded, Kind } from './types.ts';

/** Woan Technology's company id, and the one older firmware used (Nordic's). */
export const COMPANY_IDS = [0x0969, 0x0059] as const;
/** The service data UUIDs, new (0xfd3d) and old (0x0d00) firmware. */
export const SERVICE_UUIDS = ['0000fd3d-0000-1000-8000-00805f9b34fb', '00000d00-0000-1000-8000-00805f9b34fb'] as const;

type Bytes = readonly number[];
type Parse = (sd: Bytes | undefined, md: Bytes | undefined) => Partial<Decoded> | null;

interface Model {
  id: string;
  name: string;
  kind: Kind;
  parse?: Parse;
}

/* Decoders ---------------------------------------------------------------------------------- */

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Temperature and humidity from three bytes (pySwitchbot adv_parsers/_sensor_th.py,
 * decode_temp_humidity; OpenWonderLabs devicetypes/meter.md):
 * byte 0 bits 3–0 tenths of a degree; byte 1 bit 7 the sign (1 = above zero),
 * bits 6–0 whole degrees Celsius; byte 2 bit 7 the device shows °F, bits 6–0
 * relative humidity in %. All zeros is a device still starting: no reading.
 */
export function decodeTempHumidity(b: Bytes): Pick<Decoded, 'temperature' | 'humidity' | 'fahrenheit'> | null {
  if (b.length < 3) return null;
  const sign = b[1]! & 0x80 ? 1 : -1;
  const temperature = round1(sign * ((b[1]! & 0x7f) + (b[0]! & 0x0f) / 10));
  const humidity = b[2]! & 0x7f;
  if (temperature === 0 && humidity === 0) return null;
  return { temperature, humidity, fahrenheit: !!(b[2]! & 0x80) };
}

/** Battery %, service data byte 2 bits 6–0 (every battery-powered sensor's scan response). */
const sdBattery = (sd: Bytes | undefined): number | undefined => (sd && sd.length >= 3 ? sd[2]! & 0x7f : undefined);

/**
 * Meter, Meter Plus, Indoor/Outdoor Thermo-Hygrometer, Meter Pro (pySwitchbot
 * adv_parsers/meter.py, process_wosensorth): the reading is manufacturer data
 * bytes 8–10, or service data bytes 3–5 when only the scan response came; the
 * battery is in the scan response only.
 */
const thermometer: Parse = (sd, md) => {
  const raw = md && md.length >= 11 ? md.slice(8, 11) : sd && sd.length >= 6 ? sd.slice(3, 6) : undefined;
  const th = raw ? decodeTempHumidity(raw) : null;
  if (!th) return null;
  const battery = sdBattery(sd);
  return battery === undefined ? th : { ...th, battery };
};

/** The highest CO2 a Meter Pro CO2 measures (pySwitchbot meter.py CO2_MAX_PPM): above it, a glitch. */
export const CO2_MAX_PPM = 9999;

/** Meter Pro CO2 (process_wosensorth_c): a Meter Pro, plus CO2 in ppm, big-endian, manufacturer data bytes 13–14. */
const thermometerCo2: Parse = (sd, md) => {
  const th = thermometer(sd, md);
  if (!th) return null;
  if (md && md.length >= 15) {
    const co2 = (md[13]! << 8) | md[14]!;
    if (co2 <= CO2_MAX_PPM) return { ...th, co2 };
  }
  return th;
};

/** Hub 2 and Hub Mini Matter (adv_parsers/hub2.py, hubmini_matter.py): mains powered, the reading in manufacturer data bytes 13–15. */
const hub: Parse = (_sd, md) => (md && md.length >= 16 ? decodeTempHumidity(md.slice(13, 16)) : null);

/** Hub 3 (adv_parsers/hub3.py): the reading in manufacturer data bytes 13–15, motion in byte 16 bit 7. */
const hub3: Parse = (_sd, md) => {
  if (!md || md.length < 17) return null;
  const th = decodeTempHumidity(md.slice(13, 16));
  return { ...(th ?? {}), motion: !!(md[16]! & 0x80) };
};

/** Weather Station (adv_parsers/weather_station.py): manufacturer data byte 7 the battery, bytes 8–10 the reading. */
const weatherStation: Parse = (sd, md) => {
  const fromMd = md && md.length >= 11;
  const th = decodeTempHumidity(fromMd ? md.slice(8, 11) : sd && sd.length >= 6 ? sd.slice(3, 6) : []);
  if (!th) return null;
  const battery = fromMd ? md[7]! & 0x7f : sdBattery(sd);
  return battery === undefined ? th : { ...th, battery };
};

/**
 * Motion Sensor (pySwitchbot adv_parsers/motion.py, process_wopresence;
 * OpenWonderLabs devicetypes/motionsensor.md, "Motion Sensor Broadcast
 * Message"). Service data: byte 1 bit 6 someone is moving; byte 2 the
 * battery; bytes 3–4 the seconds since the PIR last fired, with byte 5 bit
 * 7 as their 17th bit; byte 5 bits 1–0 the light (1 dark, 2 bright).
 * Manufacturer data: byte 7 bit 6 motion, bit 5 bright; bytes 8–9 the same
 * seconds as service data bytes 3–4 (as in pySwitchbot's test advertisements,
 * tests/test_adv_parser.py, test_motion_sensor_*), without the 17th bit.
 */
const motionSensor: Parse = (sd, md) => {
  if (!sd && !md) return null;
  const out: Partial<Decoded> = {};
  if (sd && sd.length >= 6) {
    out.motion = !!(sd[1]! & 0x40);
    out.battery = sd[2]! & 0x7f;
    out.motionAgeS = (sd[5]! & 0x80 ? 0x10000 : 0) + ((sd[3]! << 8) | sd[4]!);
    const light = sd[5]! & 0x03;
    if (light === 1 || light === 2) out.light = light === 2;
  }
  if (md && md.length >= 8) {
    out.motion = !!(md[7]! & 0x40);
    out.light = !!(md[7]! & 0x20);
    if (out.motionAgeS === undefined && md.length >= 10) out.motionAgeS = (md[8]! << 8) | md[9]!;
  }
  return out.motion === undefined ? null : out;
};

/**
 * Contact Sensor (pySwitchbot adv_parsers/contact.py, process_wocontact;
 * OpenWonderLabs devicetypes/contactsensor.md, "Contact Sensor Broadcast
 * Message"). Service data (9 bytes): byte 1 bit 6 motion (it has a PIR
 * too); byte 2 the battery; byte 3 bits 2–1 the door (0 closed, 1 open,
 * 2 left open past the timer set in the app), bit 0 bright, bit 7 and 6 the
 * 17th bit of the PIR's and the contact's seconds; bytes 4–5 seconds since
 * the PIR fired; bytes 6–7 seconds since the contact last changed; byte 8
 * bits 3–0 the button's press counter. Newer firmware also sends the state
 * in 13 bytes of manufacturer data: byte 7 bit 7 motion, bit 6 bright,
 * bit 5 left open, bit 4 open; bytes 8–11 the same two ages as service
 * data bytes 4–7 (pySwitchbot's test_contact_sensor_open/_closed), byte 12
 * the button counter.
 */
const contactSensor: Parse = (sd, md) => {
  const fullMd = !!md && md.length >= 13;
  const fullSd = !!sd && sd.length >= 9;
  if (!fullMd && !fullSd) return null;
  const out: Partial<Decoded> = {};
  const battery = sdBattery(sd);
  if (battery !== undefined) out.battery = battery;
  let open: boolean;
  let leftOpen: boolean;
  if (fullMd) {
    out.motion = !!(md[7]! & 0x80);
    out.light = !!(md[7]! & 0x40);
    leftOpen = !!(md[7]! & 0x20);
    open = !!(md[7]! & 0x10);
    out.buttonCount = md[12]! & 0x0f;
  } else {
    out.motion = !!(sd![1]! & 0x40);
    out.light = !!(sd![3]! & 0x01);
    leftOpen = !!(sd![3]! & 0x04);
    open = !!(sd![3]! & 0x02);
    out.buttonCount = sd![8]! & 0x0f;
  }
  // "Left open" is still open (pySwitchbot: "timeout still means its open").
  out.open = open || leftOpen;
  out.leftOpen = leftOpen;
  if (fullSd) {
    out.motionAgeS = (sd![3]! & 0x80 ? 0x10000 : 0) + ((sd![4]! << 8) | sd![5]!);
    out.contactAgeS = (sd![3]! & 0x40 ? 0x10000 : 0) + ((sd![6]! << 8) | sd![7]!);
  } else {
    out.motionAgeS = (md![8]! << 8) | md![9]!;
    out.contactAgeS = (md![10]! << 8) | md![11]!;
  }
  return out;
};

/** The presence sensor's battery, in four steps (pySwitchbot const/presence_sensor.py BATTERY_LEVEL_MAP). */
const PRESENCE_BATTERY: Decoded['batteryRange'][] = ['<10', '10-19', '20-59', '>=60'];

/**
 * Presence Sensor (pySwitchbot adv_parsers/presence_sensor.py): 12 bytes of
 * manufacturer data; byte 7 bit 6 someone is there, bits 3–2 the battery
 * range; bytes 8–9 how long, in seconds, the current state has lasted
 * (pySwitchbot's `duration`); the battery % in service data byte 2.
 */
const presenceSensor: Parse = (sd, md) => {
  if (!md || md.length < 12) return null;
  const out: Partial<Decoded> = {
    motion: !!(md[7]! & 0x40),
    batteryRange: PRESENCE_BATTERY[(md[7]! >> 2) & 0x03]!,
    presenceForS: (md[8]! << 8) | md[9]!,
  };
  const battery = sdBattery(sd);
  if (battery !== undefined) out.battery = battery;
  return out;
};

/* Models ------------------------------------------------------------------------------------ */

const m = (id: string, name: string, kind: Kind, parse?: Parse): Model => ({ id, name, kind, ...(parse ? { parse } : {}) });

const METER = m('meter', 'Meter', 'climate', thermometer);
const METER_PLUS = m('meter-plus', 'Meter Plus', 'climate', thermometer);
const OUTDOOR = m('outdoor-meter', 'Indoor/Outdoor Thermo-Hygrometer', 'climate', thermometer);
const METER_PRO = m('meter-pro', 'Meter Pro', 'climate', thermometer);
const METER_PRO_CO2 = m('meter-pro-co2', 'Meter Pro CO2', 'climate', thermometerCo2);
const HUB2 = m('hub2', 'Hub 2', 'climate', hub);
const HUB_MINI_MATTER = m('hub-mini-matter', 'Hub Mini Matter', 'climate', hub);
const HUB3 = m('hub3', 'Hub 3', 'climate', hub3);
const WEATHER = m('weather-station', 'Weather Station', 'climate', weatherStation);
const MOTION = m('motion', 'Motion Sensor', 'motion', motionSensor);
const CONTACT = m('contact', 'Contact Sensor', 'contact', contactSensor);
const PRESENCE = m('presence', 'Presence Sensor', 'presence', presenceSensor);

/**
 * Device types: service data byte 0 with bit 7 cleared. Both forms of each
 * (upper case is "pair mode", lower case "constant advertising", as the
 * contact and motion documents say) from the table in OpenWonderLabs'
 * README.md, which follows pySwitchbot's SUPPORTED_TYPES.
 */
const BY_TYPE = new Map<number, Model>([
  [0x54, METER], [0x74, METER],
  [0x69, METER_PLUS], [0x49, METER_PLUS],
  [0x77, OUTDOOR], [0x57, OUTDOOR],
  [0x34, METER_PRO], [0x14, METER_PRO],
  [0x35, METER_PRO_CO2], [0x15, METER_PRO_CO2],
  [0x76, HUB2], [0x56, HUB2],
  [0x25, HUB_MINI_MATTER], [0x05, HUB_MINI_MATTER],
  [0x73, MOTION], [0x53, MOTION],
  [0x64, CONTACT], [0x44, CONTACT],
]);

/** Products without sensors this plugin reads, by device type, only to name them (same table). */
const OTHER_TYPES: [number[], string][] = [
  [[0x48], 'Bot'],
  [[0x65, 0x45], 'Humidifier'],
  [[0x63, 0x43], 'Curtain'],
  [[0x7b, 0x5b], 'Curtain 3'],
  [[0x75, 0x55], 'Color Bulb'],
  [[0x72, 0x52], 'LED Strip Light'],
  [[0x71, 0x51], 'Ceiling Light'],
  [[0x6e, 0x4e], 'Ceiling Light Pro'],
  [[0x6f, 0x4f], 'Smart Lock'],
  [[0x67, 0x47], 'Plug Mini (US)'],
  [[0x6a, 0x4a], 'Plug Mini (JP)'],
  [[0x3f, 0x1f], 'Plug Mini (EU)'],
  [[0x23, 0x03], 'Evaporative Humidifier'],
  [[0x24, 0x04], 'Smart Lock Pro'],
  [[0x2d, 0x0d], 'Smart Lock Lite'],
  [[0x78, 0x58], 'Blind Tilt'],
  [[0x26, 0x06], 'Water Leak Detector'],
  [[0x79, 0x59], 'Keypad'],
  [[0x3c, 0x1c], 'Relay Switch 1PM'],
  [[0x3b, 0x1b], 'Relay Switch 1'],
  [[0x3d, 0x1d], 'Relay Switch 2PM'],
  [[0x62, 0x42], 'Remote'],
  [[0x07, 0x27], 'Universal Remote'],
  [[0x2c, 0x0c], 'Roller Shade'],
  [[0x7e, 0x5e], 'Circulator Fan'],
  [[0x3e, 0x1e], 'Garage Door Opener'],
];
for (const [types, name] of OTHER_TYPES) {
  const model = m(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, ''), name, 'other');
  for (const t of types) BY_TYPE.set(t, model);
}

/**
 * Newer products: a 4-byte product id at the end of the service data, or
 * the four before its last byte (pySwitchbot _find_model_from_service_data_suffix;
 * OpenWonderLabs README.md, "Product ID"). Each has a 0x00… and a 0x01… form.
 */
const BY_PRODUCT = new Map<number, Model>([
  [0x0010ccc8, PRESENCE],
  [0x0010b940, HUB3],
  [0x001053b0, WEATHER],
]);

function productOf(sd: Bytes): Model | undefined {
  if (sd.length <= 5) return undefined;
  for (const off of [sd.length - 4, sd.length - 5]) {
    const id = ((sd[off]! << 24) | (sd[off + 1]! << 16) | (sd[off + 2]! << 8) | sd[off + 3]!) >>> 0;
    // The first byte is 0x00 or 0x01: the same product.
    const model = BY_PRODUCT.get(id & 0x00ffffff);
    if (model && id >>> 24 <= 1) return model;
  }
  return undefined;
}

const hex = (n: number, w = 2) => `0x${n.toString(16).padStart(w, '0')}`;

/** The model of an advertisement with service data: its device type byte, else its product id. */
export function modelOf(sd: Bytes | undefined): Model | undefined {
  if (!sd?.length) return undefined;
  return BY_TYPE.get(sd[0]! & 0x7f) ?? productOf(sd);
}

/** A model by our id (for the models remembered by address). */
export function modelById(id: string): Model | undefined {
  for (const v of [...BY_TYPE.values(), ...BY_PRODUCT.values()]) if (v.id === id) return v;
  return undefined;
}

/**
 * Decodes one advertisement. `known` is the model remembered for this
 * address: an advertisement without its scan response (a passive scan, or a
 * scan response not heard yet) has no service data to say what it is, and
 * pySwitchbot does the same (its _MODEL_TO_MAC_CACHE). Null: not a SwitchBot
 * advertisement at all.
 */
export function decode(sd: Bytes | undefined, md: Bytes | undefined, known?: string): Decoded | null {
  if (!sd?.length && !md?.length) return null;
  const sdOk = sd?.length ? sd : undefined;
  const model = modelOf(sdOk) ?? (known ? modelById(known) : undefined);
  if (!model) {
    const out: Decoded = { model: 'unknown', modelName: 'SwitchBot', kind: 'other' };
    if (sdOk) {
      out.type = sdOk[0]! & 0x7f ? hex(sdOk[0]! & 0x7f) : sdOk.length > 5 ? hex(((sdOk[sdOk.length - 4]! << 24) | (sdOk[sdOk.length - 3]! << 16) | (sdOk[sdOk.length - 2]! << 8) | sdOk[sdOk.length - 1]!) >>> 0, 8) : hex(0);
      if (sdOk[0]! & 0x80) out.encrypted = true;
    }
    return out;
  }
  const out: Decoded = { model: model.id, modelName: model.name, kind: model.kind };
  // Bit 7 of the type byte: "0: No encryption, 1: With encryption" (contactsensor.md). Its bytes are not what they seem: not read.
  if (sdOk && sdOk[0]! & 0x80) return { ...out, encrypted: true };
  const r = model.parse?.(sdOk, md?.length ? md : undefined);
  return r ? { ...out, ...r } : out;
}

/* Raw advertisement helpers ----------------------------------------------------------------- */

/** The address the manufacturer data starts with (bytes 0–5), `AA:BB:…`. */
export function addressOfMd(md: Bytes): string | undefined {
  if (md.length < 6) return undefined;
  return md.slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
}
