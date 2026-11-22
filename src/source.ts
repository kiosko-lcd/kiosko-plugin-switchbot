/**
 * The `switchbot/devices` source: each read listens for a short window (see
 * readers.ts), decodes what it heard, folds it into what it remembers and
 * gives the widgets plain data. It may run in the background, so a door left
 * open raises its full-screen alert even with no widget showing doors.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineSource, matchFilter, t, type Alert } from '@kiosko/sdk';
import { demoData } from './demo.ts';
import { L } from './i18n.ts';
import { execRun, realSleep, scan, spawnHold, type Env, type WhileAudio } from './readers.ts';
import { applyAdverts, emptyStore, forget, reviveStore, viewOf, type Store } from './state.ts';
import type { Device, ReaderStatus, SwitchBotData } from './types.ts';

export const sourceOptions = t.object({
  devices: t.filter({
    label: L('Devices', 'Dispositivos', 'Geräte', '设备', '裝置'),
    help: L(
      'Which to show, by name, address or kind (climate, contact, motion, presence); !AA:BB:* leaves one out. Empty: every SwitchBot heard.',
      'Cuáles mostrar, por nombre, dirección o tipo (climate, contact, motion, presence); !AA:BB:* quita uno. Vacío: todos los SwitchBot que se oigan.',
      'Welche gezeigt werden, nach Name, Adresse oder Art (climate, contact, motion, presence); !AA:BB:* lässt eines weg. Leer: jedes gehörte SwitchBot-Gerät.',
      '按名称、地址或类型（climate、contact、motion、presence）选择要显示的设备；用 !AA:BB:* 排除某个。留空：听到的所有 SwitchBot。',
      '依名稱、位址或類型（climate、contact、motion、presence）選擇要顯示的裝置；用 !AA:BB:* 排除某個。留空：聽到的所有 SwitchBot。',
    ),
    choices: { source: 'switchbot/devices', list: 'devices' },
  }),
  names: t.map({
    label: L('Names', 'Nombres', 'Namen', '名称', '名稱'),
    help: L(
      'A name for each device, by its Bluetooth address (the SwitchBot app shows it under the device\'s settings → Device info): "C7:6B:06:06:05:55" → "Living room".',
      'Un nombre para cada dispositivo, por su dirección Bluetooth (la app de SwitchBot la muestra en los ajustes del dispositivo → Información): "C7:6B:06:06:05:55" → "Salón".',
      'Ein Name für jedes Gerät, nach seiner Bluetooth-Adresse (die SwitchBot-App zeigt sie in den Geräteeinstellungen → Geräteinfo): "C7:6B:06:06:05:55" → "Wohnzimmer".',
      '按蓝牙地址给每个设备起名（SwitchBot 应用在设备设置 → 设备信息中显示）："C7:6B:06:06:05:55" → "客厅"。',
      '依藍牙位址為每個裝置命名（SwitchBot App 在裝置設定 → 裝置資訊中顯示）："C7:6B:06:06:05:55" → "客廳"。',
    ),
  }),
  openWarnMs: t.duration({
    default: 0,
    label: L('Highlight an open door after', 'Resaltar una puerta abierta a partir de', 'Offene Tür hervorheben nach', '门开着多久后高亮', '門開著多久後醒目顯示'),
    help: L('It turns amber. 0: as soon as it opens.', 'Se pone ámbar. 0: en cuanto se abre.', 'Sie wird gelb. 0: sobald sie aufgeht.', '显示为琥珀色。0：一打开就高亮。', '顯示為琥珀色。0：一打開就醒目顯示。'),
  }),
  openAlertMs: t.duration({
    default: 10 * 60_000,
    min: 60_000,
    label: L('Left open after', 'Abierta demasiado tiempo a partir de', 'Zu lange offen nach', '门开着多久算忘关', '門開著多久算忘了關'),
    help: L(
      'It turns red and, if full-screen alerts are on, shows one, once each time it is left open.',
      'Se pone roja y, si los avisos a pantalla completa están activados, muestra uno, una vez cada vez que se queda abierta.',
      'Sie wird rot und zeigt, wenn Vollbild-Warnungen an sind, eine Warnung, einmal jedes Mal, wenn sie offen bleibt.',
      '显示为红色；若开启全屏提醒，每次忘关只提醒一次。',
      '顯示為紅色；若開啟全螢幕提醒，每次忘了關只提醒一次。',
    ),
  }),
  showAlerts: t.boolean({
    default: true,
    label: L('Full-screen alert when a door is left open', 'Aviso a pantalla completa si una puerta se queda abierta', 'Vollbild-Warnung, wenn eine Tür offen bleibt', '门忘关时全屏提醒', '門忘了關時全螢幕提醒'),
  }),
  alertDoors: t.filter({
    label: L('Doors that alert', 'Puertas que avisan', 'Türen mit Warnung', '会提醒的门', '會提醒的門'),
    help: L(
      'Which doors may raise the full-screen alert, by name or address; !Fridge leaves one out. Empty: every door.',
      'Qué puertas pueden lanzar el aviso a pantalla completa, por nombre o dirección; !Nevera quita una. Vacío: todas.',
      'Welche Türen die Vollbild-Warnung auslösen dürfen, nach Name oder Adresse; !Kühlschrank lässt eine weg. Leer: alle.',
      '哪些门可以触发全屏提醒，按名称或地址；用 !冰箱 排除某个。留空：所有门。',
      '哪些門可以觸發全螢幕提醒，依名稱或位址；用 !冰箱 排除某個。留空：所有門。',
    ),
    choices: { source: 'switchbot/devices', list: 'doors' },
  }),
  batteryWarn: t.integer({
    default: 20,
    min: 0,
    max: 100,
    unit: '%',
    label: L('Battery low at', 'Batería baja a partir de', 'Akku niedrig ab', '低电量阈值', '低電量門檻'),
  }),
  batteryAlert: t.integer({
    default: 10,
    min: 0,
    max: 100,
    unit: '%',
    label: L('Battery almost empty at', 'Batería casi vacía a partir de', 'Akku fast leer ab', '电量告急阈值', '電量告急門檻'),
  }),
  units: t.enum(['auto', 'celsius', 'fahrenheit'] as const, {
    label: L('Temperature in', 'Temperatura en', 'Temperatur in', '温度单位', '溫度單位'),
    labels: {
      auto: L('As each thermometer shows it', 'Como la muestra cada termómetro', 'Wie jedes Thermometer sie zeigt', '与各温度计显示一致', '與各溫度計顯示一致'),
      celsius: '°C',
      fahrenheit: '°F',
    },
  }),
  staleMs: t.duration({
    default: 15 * 60_000,
    min: 2 * 60_000,
    label: L('Old after', 'Antigua a partir de', 'Veraltet nach', '多久没收到算过时', '多久沒收到算過時'),
    help: L(
      'A device not heard for this long is shown dimmed, with when it was heard last.',
      'Un dispositivo que no se oye desde hace este tiempo se muestra atenuado, con cuándo se oyó por última vez.',
      'Ein Gerät, das so lange nicht gehört wurde, wird gedimmt gezeigt, mit dem Zeitpunkt, zu dem es zuletzt gehört wurde.',
      '超过这么久没收到的设备会变暗显示，并标出最后一次收到的时间。',
      '超過這麼久沒收到的裝置會變暗顯示，並標出最後一次收到的時間。',
    ),
    advanced: true,
  }),
  listenMs: t.duration({
    default: 10_000,
    min: 2000,
    max: 60_000,
    label: L('Listen for', 'Escuchar durante', 'Zuhören für', '每次收听时长', '每次收聽時長'),
    help: L(
      'Each read scans Bluetooth this long, then rests until the next one (the source\'s interval, a minute by default). Shorter is gentler on Bluetooth headphones playing on the same adapter; longer hears far devices better.',
      'Cada lectura escucha el Bluetooth este tiempo y luego descansa hasta la siguiente (el intervalo de la fuente, un minuto por defecto). Más corto molesta menos a unos auriculares Bluetooth que suenen en el mismo adaptador; más largo oye mejor los dispositivos lejanos.',
      'Jedes Lesen scannt Bluetooth so lange und ruht dann bis zum nächsten (das Intervall der Quelle, standardmäßig eine Minute). Kürzer stört Bluetooth-Kopfhörer am selben Adapter weniger; länger hört entfernte Geräte besser.',
      '每次读取会扫描蓝牙这么久，然后休息到下一次（数据源的间隔，默认一分钟）。越短对同一适配器上播放的蓝牙耳机影响越小；越长越能听到远处的设备。',
      '每次讀取會掃描藍牙這麼久，然後休息到下一次（資料來源的間隔，預設一分鐘）。越短對同一介面卡上播放的藍牙耳機影響越小；越長越能聽到遠處的裝置。',
    ),
    advanced: true,
  }),
  whileAudio: t.enum(['short', 'pause', 'normal'] as const, {
    label: L('While Bluetooth audio plays', 'Mientras suena audio Bluetooth', 'Während Bluetooth-Audio läuft', '蓝牙音频播放时', '藍牙音訊播放時'),
    labels: {
      short: L('Listen briefly (3 s)', 'Escuchar poco (3 s)', 'Kurz zuhören (3 s)', '短暂收听（3 秒）', '短暫收聽（3 秒）'),
      pause: L("Don't scan", 'No escanear', 'Nicht scannen', '不扫描', '不掃描'),
      normal: L('As usual', 'Como siempre', 'Wie immer', '照常', '照常'),
    },
    advanced: true,
  }),
});

export type Options = {
  devices: string[];
  names: Record<string, string>;
  openWarnMs: number;
  openAlertMs: number;
  showAlerts: boolean;
  alertDoors: string[];
  batteryWarn: number;
  batteryAlert: number;
  units: 'auto' | 'celsius' | 'fahrenheit';
  staleMs: number;
  listenMs: number;
  whileAudio: WhileAudio;
};

/** The short window while audio plays. */
export const SHORT_MS = 3000;
/** How often BlueZ is asked during a window. */
export const POLL_MS = 2000;
/** The state is written at most this often, unless a door or a model changed. */
export const SAVE_EVERY_MS = 5 * 60_000;

export interface StateFile {
  load(): Promise<Store>;
  save(s: Store, now: number, urgent: boolean): Promise<void>;
}

/** The store in memory, and in `dataDir/state.json`: written when something that matters changed, else every few minutes. */
export function stateFile(dataDir: string): StateFile {
  let cache: Store | undefined;
  let savedAt = 0;
  const file = join(dataDir, 'state.json');
  return {
    async load() {
      if (cache) return cache;
      try {
        cache = reviveStore(JSON.parse(await readFile(file, 'utf8')));
      } catch {
        cache = emptyStore();
      }
      return cache;
    },
    async save(s, now, urgent) {
      cache = s;
      if (!urgent && now - savedAt < SAVE_EVERY_MS) return;
      savedAt = now;
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(s));
        await rename(`${file}.tmp`, file);
      } catch {
        /* kept in memory */
      }
    },
  };
}

/** What changed that must be written now: a new model learnt, a door opened or closed. */
export function mattersNow(prev: Store, next: Store): boolean {
  if (Object.keys(prev.models).length !== Object.keys(next.models).length) return true;
  return Object.values(next.devices).some((d) => d.kind === 'contact' && (prev.devices[d.key]?.open !== d.open || prev.devices[d.key]?.openSince !== d.openSince));
}

export function dataOf(store: Store, status: ReaderStatus, o: Options, now: number): SwitchBotData {
  return {
    at: now,
    devices: viewOf(store, now, o),
    status,
    openWarnMs: o.openWarnMs,
    openAlertMs: o.openAlertMs,
    batteryWarn: o.batteryWarn,
    batteryAlert: o.batteryAlert,
    fullScreen: o.showAlerts,
    alertDoors: o.alertDoors,
    units: o.units,
  };
}

export interface ReadDeps {
  env?: Partial<Env>;
  state: StateFile;
}

/** One read, with everything it touches passed in (tests give fakes). */
export async function readSwitchBot(o: Options, ctx: { now: number; signal: AbortSignal; log?: (m: string) => void }, deps: ReadDeps): Promise<SwitchBotData> {
  const env: Env = { run: execRun, hold: spawnHold, platform: process.platform, signal: ctx.signal, now: Date.now, sleep: realSleep, ...deps.env };
  const res = await scan(env, { listenMs: o.listenMs, pollMs: POLL_MS, whileAudio: o.whileAudio, shortMs: SHORT_MS });
  if (res.status.state === 'error' || res.status.message) ctx.log?.(`switchbot/${res.status.reader}: ${res.status.message ?? res.status.state}`);
  const prev = await deps.state.load();
  const now = Math.max(ctx.now, env.now());
  const next = forget(applyAdverts(prev, res.adverts), now);
  await deps.state.save(next, now, mattersNow(prev, next));
  return dataOf(next, res.status, o, now);
}

/* Alerts ------------------------------------------------------------------------------------ */

/** "12 min", "1 h 05", as plain text in each language (alerts get no formatters). */
function minutesText(ms: number) {
  const m = Math.max(1, Math.floor(ms / 60_000));
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const en = h ? `${h} h ${mm}` : `${m} min`;
  const zhHans = h ? `${h} 小时 ${m % 60} 分钟` : `${m} 分钟`;
  const zhHant = h ? `${h} 小時 ${m % 60} 分鐘` : `${m} 分鐘`;
  return { en, es: en, de: en, hans: zhHans, hant: zhHant };
}

const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** A door without a name of the user's, in an alert: by the end of its address. */
const doorLabel = (d: Device) => d.name || `${d.key.slice(-5).replace(':', '')}`;

/**
 * One alert per door left open, once per time it is left open: the id has
 * when it opened, which stays the same while it is open (state.ts), so
 * "Seen" hides it until the door is closed and left open again.
 */
export function doorAlerts(data: SwitchBotData | undefined, options: Partial<Pick<Options, 'alertDoors'>> | undefined, now: number): Alert[] {
  if (!data?.fullScreen) return [];
  const out: Alert[] = [];
  for (const d of data.devices) {
    if (d.kind !== 'contact' || !d.open || d.openSince === undefined || d.stale) continue;
    if (now - d.openSince < data.openAlertMs) continue;
    if (!matchFilter([d.name, d.key].filter(Boolean), options?.alertDoors ?? data.alertDoors)) continue;
    const n = doorLabel(d);
    const t = minutesText(now - d.openSince);
    const at = clock(d.openSince);
    out.push({
      id: `door-${d.key}@${d.openSince}`,
      level: 'warn',
      icon: 'door-open',
      title: d.name
        ? L(`${n} is open`, `${n}: abierta`, `${n} ist offen`, `${n}没关`, `${n}沒關`)
        : L(`Door ${n} is open`, `Puerta ${n} abierta`, `Tür ${n} ist offen`, `门 ${n} 没关`, `門 ${n} 沒關`),
      text: L(`Open for ${t.en} · since ${at}`, `Lleva abierta ${t.es} · desde las ${at}`, `Seit ${t.de} offen · seit ${at}`, `已开 ${t.hans} · 自 ${at} 起`, `已開 ${t.hant} · 自 ${at} 起`),
      source: 'SwitchBot',
    });
  }
  return out;
}

/* The source -------------------------------------------------------------------------------- */

const files = new Map<string, StateFile>();

export const devicesSource = defineSource({
  id: 'devices',
  name: L('SwitchBot sensors', 'Sensores SwitchBot', 'SwitchBot-Sensoren', 'SwitchBot 传感器', 'SwitchBot 感測器'),
  description: L(
    'SwitchBot thermometers, hygrometers, door and motion sensors, heard straight from this computer\'s Bluetooth: what they broadcast every few seconds, read without pairing, connecting or a hub, and without the cloud. Linux (BlueZ) for now.',
    'Termómetros, higrómetros, sensores de puerta y de movimiento SwitchBot, oídos directamente por el Bluetooth de este ordenador: lo que emiten cada pocos segundos, leído sin emparejar, sin conectarse, sin hub y sin la nube. De momento, en Linux (BlueZ).',
    'SwitchBot-Thermometer, -Hygrometer, Tür- und Bewegungssensoren, direkt über das Bluetooth dieses Computers gehört: was sie alle paar Sekunden senden, gelesen ohne Koppeln, ohne Verbindung, ohne Hub und ohne Cloud. Vorerst unter Linux (BlueZ).',
    '直接用这台电脑的蓝牙接收 SwitchBot 温湿度计、门窗传感器和人体传感器每隔几秒发出的广播：无需配对、连接、网关，也不经过云端。目前支持 Linux（BlueZ）。',
    '直接用這台電腦的藍牙接收 SwitchBot 溫濕度計、門窗感測器和人體感測器每隔幾秒發出的廣播：不必配對、連線、網關，也不經過雲端。目前支援 Linux（BlueZ）。',
  ),
  options: sourceOptions,
  intervalMs: 60_000,
  minIntervalMs: 15_000,
  timeoutMs: 90_000,
  background: true,
  async read(ctx) {
    let state = files.get(ctx.dataDir);
    if (!state) files.set(ctx.dataDir, (state = stateFile(ctx.dataDir)));
    return readSwitchBot(ctx.options as Options, { now: ctx.now, signal: ctx.signal, log: ctx.log }, { state });
  },
  demo: ({ now, locale }) => demoData(now, locale),
  alerts: ({ data, options, now }) => doorAlerts(data, options as Options, now),
  choices: {
    devices: (data) => data.devices.map((d) => ({ value: d.name || d.key, label: d.name ? `${d.name} (${d.modelName})` : `${d.key} (${d.modelName})`, group: d.kind })),
    doors: (data) => data.devices.filter((d) => d.kind === 'contact').map((d) => ({ value: d.name || d.key })),
  },
});
