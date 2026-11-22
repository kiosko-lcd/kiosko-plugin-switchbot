/** What every widget of the plugin shares: the source's data, names, numbers, messages. */
import type { Graphics, Localized, RenderContext } from '@kiosko/sdk';
import { drawCheck } from './draw.ts';
import { L } from './i18n.ts';
import type { Device, Kind, SwitchBotData } from './types.ts';

export const SOURCE = 'switchbot/devices';
/** The smallest text drawn, in px of the box: readable on a panel across the room. */
export const MIN_PX = 11;

export type Ctx = RenderContext<any, any>;

export const dataOf = (sources: Record<string, unknown>): SwitchBotData | undefined => sources[SOURCE] as SwitchBotData | undefined;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const KIND_LABELS: Record<Kind, Localized> = {
  climate: L('Thermometer', 'Termómetro', 'Thermometer', '温湿度计', '溫濕度計'),
  contact: L('Door', 'Puerta', 'Tür', '门', '門'),
  motion: L('Motion', 'Movimiento', 'Bewegung', '人体感应', '人體感應'),
  presence: L('Presence', 'Presencia', 'Anwesenheit', '人在感应', '人在感應'),
  other: L('SwitchBot', 'SwitchBot', 'SwitchBot', 'SwitchBot', 'SwitchBot'),
};

/** The user's name, else the kind and the end of the address ("Thermometer 0555"): three alike stay apart. */
export const nameOf = (ctx: Pick<Ctx, 't'>, d: Device): string => d.name || `${ctx.t(KIND_LABELS[d.kind])} ${d.key.slice(-5).replace(':', '')}`;

/** Paints inside the box only, whatever happens. */
export function clipped(g: Graphics, ctx: Ctx, paint: () => void): void {
  const { box } = ctx;
  g.save();
  g.beginPath();
  g.rect(box.x, box.y, box.w, box.h);
  g.clip();
  try {
    paint();
  } finally {
    g.restore();
  }
}

const numberFormats = new Map<string, Intl.NumberFormat>();
/** A number with one decimal, as the language writes it ("21,5"). */
export function oneDecimal(locale: string, n: number): string {
  let f = numberFormats.get(locale);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    } catch {
      f = new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }
    numberFormats.set(locale, f);
  }
  return f.format(n).replace('-', '−');
}

/** Whether this device's temperature is shown in °F: the source's units, or the thermometer's own screen. */
export const inFahrenheit = (data: SwitchBotData, d: Device) => (data.units === 'auto' ? !!d.fahrenheit : data.units === 'fahrenheit');

/** "21,5°" ("55,2°F" in °F); `unit` adds the C too. */
export function tempText(ctx: Pick<Ctx, 'locale'>, data: SwitchBotData, d: Device, unit = false): string {
  if (d.temperature === undefined) return '–';
  const f = inFahrenheit(data, d);
  const v = f ? (d.temperature * 9) / 5 + 32 : d.temperature;
  // °F is always said: a reading in °F next to ones in °C would otherwise look like a fever.
  return `${oneDecimal(ctx.locale, v)}°${f ? 'F' : unit ? 'C' : ''}`;
}

/**
 * The largest size, up to `font.size`, at which `text` fits in `maxW`: one
 * measure and a rule of three (text width grows with its size), then a
 * check, instead of trying every pixel size down from a big number.
 */
export function fitText(ctx: Pick<Ctx, 'kit'>, g: Graphics, text: string, maxW: number, font: { size: number; family: string }, min = MIN_PX): number {
  const w = ctx.kit.measureTracked(g, text, { ...font, size: 100 });
  let size = w > 0 ? Math.min(font.size, Math.floor((100 * maxW) / w)) : font.size;
  while (size > min && ctx.kit.measureTracked(g, text, { ...font, size }) > maxW) size--;
  return Math.max(min, size);
}

/** "52%" or "52 %", as each language writes it. */
export function pctText(ctx: Pick<Ctx, 't'>, n: number): string {
  const s = String(Math.round(n));
  return ctx.t({ en: `${s}%`, es: `${s} %`, de: `${s} %`, 'zh-Hans': `${s}%`, 'zh-Hant': `${s}%` });
}

export const WAITING = L('Listening…', 'Escuchando…', 'Lausche…', '正在接收…', '正在接收…');

/** Why there is nothing: the reader's own words (no adapter, Bluetooth off), or a hint. */
export function noneHint(ctx: Ctx, data: SwitchBotData): string {
  const m = data.status.message ?? '';
  if (data.status.state === 'off' && /off/i.test(m)) return ctx.t(L('Bluetooth is off', 'El Bluetooth está apagado', 'Bluetooth ist aus', '蓝牙已关闭', '藍牙已關閉'));
  if (data.status.state === 'off' && /adapter/i.test(m)) return ctx.t(L('No Bluetooth adapter', 'No hay adaptador Bluetooth', 'Kein Bluetooth-Adapter', '没有蓝牙适配器', '沒有藍牙介面卡'));
  if (data.status.state === 'off') return ctx.t(L('Linux only for now', 'De momento solo en Linux', 'Vorerst nur unter Linux', '目前仅支持 Linux', '目前僅支援 Linux'));
  return ctx.t(L('Bring it closer, or see Settings → Data sources', 'Acércalo, o mira Ajustes → Fuentes de datos', 'Näher heranbringen oder Einstellungen → Datenquellen ansehen', '把它移近一点，或查看“设置 → 数据源”', '把它移近一點，或查看「設定 → 資料來源」'));
}

/** A message in the middle of the box, with a check for the calm ones and a dimmer line under it. */
export function drawMessage(g: Graphics, ctx: Ctx, text: string, o: { check?: boolean; sub?: string } = {}): void {
  const { box, kit, theme } = ctx;
  const c = theme.colors;
  const size = clamp(Math.round(Math.min(box.h * 0.3, box.w / 10)), MIN_PX, 34);
  const icon = o.check ? clamp(Math.round(size * 1.4), 14, 56) : 0;
  const subSize = clamp(Math.round(size * 0.62), MIN_PX, 20);
  const sub = o.sub && box.h >= size + subSize * 1.6 ? o.sub : '';
  const blockH = sub ? size + subSize * 1.5 : size;
  const top = box.y + Math.max(0, (box.h - Math.max(blockH, icon)) / 2);
  let x = box.x;
  if (icon && box.w >= icon * 3.5) {
    drawCheck(g, x, top + (Math.max(blockH, icon) - icon) / 2, icon, c.ok);
    x += icon + Math.round(size * 0.5);
  }
  const textTop = top + (Math.max(blockH, icon) - blockH) / 2;
  const font = { size, family: theme.fonts.sans, color: o.check ? c.ink : c.inkDim };
  kit.drawTracked(g, kit.truncate(g, text, box.x + box.w - x, font), x, textTop + size * 0.85, font);
  if (sub) {
    const f2 = { size: subSize, family: theme.fonts.sans, color: c.inkFaint };
    kit.drawTracked(g, kit.truncate(g, sub, box.x + box.w - x, f2), x, textTop + size + subSize * 1.15, f2);
  }
}

/** Columns for a wide box (a strip of 1920×462): about one per 1.6 heights, each at least 280 px wide. */
export function columnsFor(w: number, h: number, n: number): number {
  return Math.max(1, Math.min(n, Math.floor(w / 280), Math.round(w / (h * 1.6))));
}

/**
 * One item of a list: icon, name and a value on the right; on a narrow,
 * tall enough row whose name wouldn't fit, the value goes under the name.
 */
export function drawRow(
  g: Graphics,
  ctx: Ctx,
  row: { x: number; y: number; w: number; h: number },
  o: { icon?: (x: number, y: number, s: number, color: string) => void; name: string; value: string; color: string; nameColor?: string; valueBold?: boolean; size?: number },
): void {
  const { kit, theme } = ctx;
  const nf = (size: number) => ({ size, family: theme.fonts.sans, color: o.nameColor ?? theme.colors.ink });
  const vf = (size: number) => ({ size, family: o.valueBold === false ? theme.fonts.sans : theme.fonts.sansBold, color: o.color });
  const size = o.size ?? clamp(Math.round(Math.min(row.h * 0.5, row.w / 11)), MIN_PX, 44);
  const gap = Math.max(4, Math.round(size * 0.45));
  const cy = row.y + row.h / 2;
  const iconFor = (s: number) => clamp(Math.round(Math.min(row.h * 0.72, s * 1.45)), 11, 48);
  // Two lines: when the name would be cut on one and the row has the height.
  const one = iconFor(size) + gap + kit.measureTracked(g, o.name, nf(size)) + gap + kit.measureTracked(g, o.value, vf(size));
  const size2 = clamp(Math.round(Math.min(row.h * 0.36, row.w / 9)), MIN_PX, 30);
  if (one > row.w && row.h >= size2 * 2.5) {
    const icon = clamp(Math.round(size2 * 1.6), 11, 48);
    let x = row.x;
    if (o.icon && row.w >= icon * 4) {
      o.icon(x, cy - icon / 2, icon, o.color);
      x += icon + Math.max(4, Math.round(size2 * 0.45));
    }
    const room = row.x + row.w - x;
    const sub = Math.max(MIN_PX, Math.round(size2 * 0.9));
    const top = cy - (size2 + sub * 1.25) / 2;
    // Shrunk a little before it is cut: a name says which door.
    const ns = fitText(ctx, g, o.name, room, nf(size2), Math.max(MIN_PX, Math.round(size2 * 0.75)));
    kit.drawTracked(g, kit.truncate(g, o.name, room, nf(ns)), x, top + size2 * 0.85, nf(ns));
    kit.drawTracked(g, kit.truncate(g, o.value, room, vf(sub)), x, top + size2 + sub * 1.1, vf(sub));
    return;
  }
  const base = cy + size * 0.36;
  let x = row.x;
  const icon = iconFor(size);
  if (o.icon && row.w >= icon * 5) {
    o.icon(x, cy - icon / 2, icon, o.color);
    x += icon + gap;
  }
  const vw = Math.min(kit.measureTracked(g, o.value, vf(size)), row.w * 0.55);
  kit.drawTracked(g, kit.truncate(g, o.value, vw + 1, vf(size)), row.x + row.w, base, { ...vf(size), align: 'right' });
  const room = row.x + row.w - vw - gap - x;
  if (room <= MIN_PX) return;
  kit.drawTracked(g, kit.truncate(g, o.name, room, nf(size)), x, base, nf(size));
}
