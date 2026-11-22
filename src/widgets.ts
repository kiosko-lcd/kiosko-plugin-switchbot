/**
 * Four widgets on the `switchbot/devices` source: the air of each room
 * (`climate`), the doors (`doors`), motion and presence (`presence`) and the
 * batteries running low (`batteries`).
 */
import { defineWidget, drawMore, listLayout, listOptions, matchFilter, t, type Graphics, type StateContext } from '@kiosko/sdk';
import {
  MIN_PX,
  SOURCE,
  WAITING,
  clamp,
  clipped,
  columnsFor,
  dataOf,
  drawMessage,
  drawRow,
  fitText,
  nameOf,
  noneHint,
  pctText,
  tempText,
  type Ctx,
} from './common.ts';
import { demoData } from './demo.ts';
import { drawBattery, drawDoor, drawMotion, drawSparkline, drawThermometer, drawTrend } from './draw.ts';
import { L } from './i18n.ts';
import { historyWindow, trendOf } from './state.ts';
import type { Device, SwitchBotData } from './types.ts';

const demo = ({ now, locale }: { now: number; locale: string }) => ({ sources: { [SOURCE]: demoData(now, locale) } });

const deviceFilter = () =>
  t.filter({
    label: L('Devices', 'Dispositivos', 'Geräte', '设备', '裝置'),
    help: L('Which to show, by name or address; !name leaves one out. Empty: all.', 'Cuáles mostrar, por nombre o dirección; !nombre quita uno. Vacío: todos.', 'Welche gezeigt werden, nach Name oder Adresse; !Name lässt eines weg. Leer: alle.', '按名称或地址选择要显示的；用 !名称 排除某个。留空：全部。', '依名稱或位址選擇要顯示的；用 !名稱 排除某個。留空：全部。'),
    choices: { source: SOURCE, list: 'devices' },
  });

/** The tallest a list row gets. */
const ROW_MAX = 110;

const pick = (data: SwitchBotData | undefined, filter: string[] | undefined, keep: (d: Device) => boolean) =>
  (data?.devices ?? []).filter((d) => keep(d) && matchFilter([d.name, d.key, d.model].filter(Boolean), filter));

/** Lays a list out in columns on a wide box, one column elsewhere. */
function drawColumns<T>(g: Graphics, ctx: Ctx, items: T[], rows: number, paint: (g: Graphics, ctx: Ctx, items: T[]) => void): void {
  const { box } = ctx;
  // Only as many columns as the items need: three doors are three big rows, not three columns of one.
  const fit = Math.max(1, Math.floor(box.h / ROW_MAX));
  const cols = rows > 0 ? 1 : Math.min(columnsFor(box.w, box.h, items.length), Math.ceil(items.length / fit));
  if (cols <= 1) return paint(g, ctx, items);
  const per = Math.ceil(items.length / cols);
  const gutter = Math.round(box.h * 0.08);
  const colW = (box.w - gutter * (cols - 1)) / cols;
  for (let i = 0; i < cols; i++) paint(g, { ...ctx, box: { x: box.x + i * (colW + gutter), y: box.y, w: colW, h: box.h } }, items.slice(i * per, (i + 1) * per));
}

/* Climate ----------------------------------------------------------------------------------- */

const thermometers = (data: SwitchBotData | undefined, filter: string[] | undefined) => pick(data, filter, (d) => d.kind === 'climate' && d.temperature !== undefined);

/** The grid for `n` cells in the box: the arrangement whose cells are biggest, wide rather than tall. */
export function gridFor(w: number, h: number, n: number, gap: number): { cols: number; rows: number } {
  let best = { cols: 1, rows: n, score: -1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (w - gap * (cols - 1)) / cols;
    const ch = (h - gap * (rows - 1)) / rows;
    // A cell narrower than this can't hold a name and a reading side by side.
    const score = cols > 1 && cw < 120 ? -1 : Math.min(cw / 1.5, ch);
    if (score > best.score + 0.5) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

function humidityText(ctx: Ctx, d: Device): string {
  const parts: string[] = [];
  if (d.humidity !== undefined) parts.push(pctText(ctx, d.humidity));
  if (d.co2 !== undefined) parts.push(`${d.co2} ppm`);
  return parts.join(' · ');
}

/** A thermometer on one line: name, then temperature and humidity on the right. */
function drawClimateRow(g: Graphics, ctx: Ctx, data: SwitchBotData, d: Device, box: { x: number; y: number; w: number; h: number }): void {
  const { kit, theme } = ctx;
  const c = theme.colors;
  const size = clamp(Math.round(Math.min(box.h * 0.56, box.w / 8)), MIN_PX, 34);
  const base = box.y + box.h / 2 + size * 0.36;
  const ink = d.stale ? c.inkFaint : c.ink;
  const tf = { size, family: theme.fonts.sansBold, color: ink };
  const temp = tempText(ctx, data, d);
  const right = box.x + box.w;
  const tw = kit.drawTracked(g, temp, right, base, { ...tf, align: 'right' });
  let end = right - tw - Math.round(size * 0.4);
  const hum = d.humidity !== undefined ? pctText(ctx, d.humidity) : '';
  const hf = { size: Math.max(MIN_PX, Math.round(size * 0.8)), family: theme.fonts.sans, color: d.stale ? c.inkFaint : c.inkDim };
  const hw = hum ? kit.measureTracked(g, hum, hf) : 0;
  const nf = { size: Math.max(MIN_PX, Math.round(size * 0.85)), family: theme.fonts.sans, color: d.stale ? c.inkFaint : c.inkDim };
  // Humidity only if the name keeps a few letters.
  if (hum && end - hw - box.x > nf.size * 4) {
    kit.drawTracked(g, hum, end, base, { ...hf, align: 'right' });
    end -= hw + Math.round(size * 0.5);
  }
  const room = end - box.x;
  if (room > MIN_PX * 2) kit.drawTracked(g, kit.truncate(g, nameOf(ctx, d), room, nf), box.x, base, nf);
}

/** A thermometer as a card: its name, the temperature big with its trend, the humidity, and the last hours under them. */
function drawClimateCard(g: Graphics, ctx: Ctx, data: SwitchBotData, d: Device, box: { x: number; y: number; w: number; h: number }, historyMs: number, widest: string): void {
  const { kit, theme } = ctx;
  const c = theme.colors;
  const ink = d.stale ? c.inkFaint : c.ink;
  const dim = d.stale ? c.inkFaint : c.inkDim;
  const nameSize = clamp(Math.round(Math.min(box.h * 0.13, box.w / 9)), MIN_PX, 28);
  const nf = { size: nameSize, family: theme.fonts.sans, color: dim };
  let nameRoom = box.w;
  if (d.stale) {
    const ago = ctx.fmt.ago(d.lastSeen);
    const af = { ...nf, color: c.inkFaint };
    const aw = kit.measureTracked(g, ago, af);
    if (aw < box.w * 0.5) {
      kit.drawTracked(g, ago, box.x + box.w, box.y + nameSize * 0.95, { ...af, align: 'right' });
      nameRoom -= aw + nameSize * 0.6;
    }
  } else if (box.w >= nameSize * 9) drawThermometer(g, box.x + box.w - nameSize * 1.1, box.y + nameSize * 0.05, nameSize * 1.1, c.inkFaint);
  if (!d.stale && box.w >= nameSize * 9) nameRoom -= nameSize * 1.4;
  kit.drawTracked(g, kit.truncate(g, nameOf(ctx, d), nameRoom, nf), box.x, box.y + nameSize * 0.95, nf);

  const hist = historyMs > 0 ? historyWindow(d.history, ctx.now, historyMs) : undefined;
  // Half an hour of readings at least: two points make a line that says nothing.
  const hasSpark = !!hist && hist.temp.filter((v) => v != null).length >= 6;
  const sparkH = hasSpark && box.h >= 96 ? Math.round(box.h * (box.h > box.w * 1.3 ? 0.28 : 0.24)) : 0;
  const top = box.y + nameSize * 1.35;
  const bottom = box.y + box.h - (sparkH ? sparkH + Math.round(box.h * 0.05) : 0);
  const areaH = Math.max(0, bottom - top);
  const temp = tempText(ctx, data, d);
  const hum = humidityText(ctx, d);
  const trend = trendOf(d.history);
  const wide = box.w >= areaH * 2.6 && !!hum;
  const tf = { size: 10, family: theme.fonts.sansBold, color: ink };
  if (wide) {
    tf.size = clamp(Math.round(areaH * 0.9), MIN_PX, 200);
    // Sized for the widest reading shown, so every card's number is the same size.
    tf.size = fitText(ctx, g, widest, box.w * 0.6, tf);
    const base = top + (areaH + tf.size * 0.72) / 2;
    const tw = kit.drawTracked(g, temp, box.x, base, tf);
    const aw = Math.round(tf.size * 0.26);
    let x = box.x + tw + Math.round(tf.size * 0.12);
    if (trend === 'up' || trend === 'down') {
      drawTrend(g, trend, x, base - tf.size * 0.62, aw, tf.size * 0.5, dim);
      x += aw + Math.round(tf.size * 0.12);
    }
    const hf = { size: clamp(Math.round(tf.size * 0.4), MIN_PX, 64), family: theme.fonts.sans, color: dim };
    const room = box.x + box.w - x;
    if (room > hf.size * 2) {
      hf.size = fitText(ctx, g, hum, room, hf);
      kit.drawTracked(g, kit.truncate(g, hum, room, hf), box.x + box.w, base, { ...hf, align: 'right' });
    }
  } else {
    const humH = hum ? Math.round(areaH * 0.3) : 0;
    tf.size = clamp(Math.round((areaH - humH) * 0.85), MIN_PX, 200);
    tf.size = fitText(ctx, g, widest, box.w * 0.84, tf);
    const base = top + tf.size * 0.8 + Math.max(0, (areaH - humH - tf.size * 0.9) / 2);
    const tw = kit.drawTracked(g, temp, box.x, base, tf);
    if (trend === 'up' || trend === 'down') {
      const aw = Math.round(tf.size * 0.26);
      if (box.x + tw + aw * 1.4 <= box.x + box.w) drawTrend(g, trend, box.x + tw + Math.round(tf.size * 0.1), base - tf.size * 0.62, aw, tf.size * 0.5, dim);
    }
    if (hum && humH >= MIN_PX) {
      const hf = { size: clamp(Math.round(humH * 0.8), MIN_PX, 64), family: theme.fonts.sans, color: dim };
      hf.size = fitText(ctx, g, hum, box.w, hf);
      kit.drawTracked(g, kit.truncate(g, hum, box.w, hf), box.x, Math.min(bottom - 2, base + humH * 0.95), hf);
    }
  }
  if (sparkH && hist) {
    const color = d.stale ? c.inkFaint : c.accent;
    drawSparkline(g, hist.temp, box.x, box.y + box.h - sparkH, box.w, sparkH, { color, area: ctx.kit.css(ctx.kit.hex(color), 0.16), minRange: 2 });
  }
}

function drawClimate(g: Graphics, ctx: Ctx, data: SwitchBotData, list: Device[], historyMs: number): void {
  const { box } = ctx;
  const gap = Math.round(Math.min(box.w, box.h) * 0.06);
  let { cols, rows } = gridFor(box.w, box.h, list.length, gap);
  // Too many for the box: as many rows as are readable.
  const minRow = 24;
  if ((box.h - gap * (rows - 1)) / rows < minRow) rows = Math.max(1, Math.floor((box.h + gap) / (minRow + gap)));
  const shown = list.slice(0, cols * rows);
  const cw = (box.w - gap * (cols - 1)) / cols;
  const ch = (box.h - gap * (rows - 1)) / rows;
  const widest = shown.map((d) => tempText(ctx, data, d)).sort((a, b) => b.length - a.length)[0] ?? '';
  shown.forEach((d, i) => {
    const cell = { x: box.x + (i % cols) * (cw + gap), y: box.y + Math.floor(i / cols) * (ch + gap), w: cw, h: ch };
    if (cell.h >= 64 && cell.w >= 90) drawClimateCard(g, ctx, data, d, cell, historyMs, widest);
    else drawClimateRow(g, ctx, data, d, cell);
  });
}

export const climate = defineWidget({
  id: 'climate',
  name: L('Room climate', 'Clima de casa', 'Raumklima', '室内温湿度', '室內溫濕度'),
  description: L(
    'Temperature and humidity of each SwitchBot thermometer: big, with an arrow when it is rising or falling and a line of the last hours. One fills the tile; several share it.',
    'Temperatura y humedad de cada termómetro SwitchBot: en grande, con una flecha cuando sube o baja y una línea de las últimas horas. Uno llena la tesela; varios se la reparten.',
    'Temperatur und Luftfeuchte jedes SwitchBot-Thermometers: groß, mit einem Pfeil, wenn sie steigt oder fällt, und einer Linie der letzten Stunden. Eines füllt die Kachel, mehrere teilen sie.',
    '每个 SwitchBot 温湿度计的温度和湿度：大字显示，升降时带箭头，并附最近几小时的曲线。一个占满格子，多个则平分。',
    '每個 SwitchBot 溫濕度計的溫度和濕度：大字顯示，升降時帶箭頭，並附最近幾小時的曲線。一個佔滿方格，多個則平分。',
  ),
  icon: 'thermometer',
  category: 'info',
  tags: ['switchbot', 'temperature', 'humidity', 'bluetooth'],
  size: { min: { w: 120, h: 40 }, preferred: { w: 480, h: 240 } },
  sources: [SOURCE],
  options: t.object({
    devices: deviceFilter(),
    historyMs: t.duration({
      default: 12 * 3600_000,
      max: 24 * 3600_000,
      label: L('Line of the last', 'Línea de las últimas', 'Linie der letzten', '曲线显示最近', '曲線顯示最近'),
      help: L('0: no line.', '0: sin línea.', '0: keine Linie.', '0：不显示曲线。', '0：不顯示曲線。'),
    }),
  }),
  redraw: 'minute',
  empty: ({ sources, options }) => !!dataOf(sources) && thermometers(dataOf(sources), options.devices).length === 0,
  render(g, ctx) {
    const data = dataOf(ctx.sources);
    clipped(g, ctx, () => {
      if (!data) return drawMessage(g, ctx, ctx.t(WAITING));
      const list = thermometers(data, ctx.options.devices);
      if (!list.length) return drawMessage(g, ctx, ctx.t(L('No thermometer heard', 'No se oye ningún termómetro', 'Kein Thermometer gehört', '未收到温湿度计', '沒收到溫濕度計')), { sub: noneHint(ctx, data) });
      drawClimate(g, ctx, data, list, ctx.options.historyMs);
    });
  },
  demo,
});

/* Doors ------------------------------------------------------------------------------------- */

const doorsOf = (data: SwitchBotData | undefined, filter: string[] | undefined) => pick(data, filter, (d) => d.kind === 'contact');
const isOpen = (d: Device) => !!d.open && !d.stale && d.openSince !== undefined;

/** Open first (the longest open on top), then closed, then the ones not heard lately. */
export function sortDoors(list: Device[]): Device[] {
  const rank = (d: Device) => (isOpen(d) ? 0 : d.stale ? 2 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || (isOpen(a) ? a.openSince! - b.openSince! : 0) || (a.name || a.key).localeCompare(b.name || b.key));
}

function doorColor(ctx: Ctx, data: SwitchBotData, d: Device): string {
  const c = ctx.theme.colors;
  if (!isOpen(d)) return d.stale ? c.inkFaint : c.inkDim;
  const ms = ctx.now - d.openSince!;
  return ms >= data.openAlertMs ? c.alert : ms >= data.openWarnMs ? c.warn : c.ink;
}

const CLOSED = L('Closed', 'Cerrada', 'Zu', '已关', '已關');
const OPEN = L('Open', 'Abierta', 'Offen', '开着', '開著');

function drawDoorList(g: Graphics, ctx: Ctx, data: SwitchBotData, list: Device[], rows: number): void {
  const { box } = ctx;
  const plan = listLayout(box, list.length, { rows }, { sizes: { 'one-line': { min: 20, max: ROW_MAX } } });
  const pad = Math.round(plan.rowH * 0.08);
  plan.rows.forEach((row, i) => {
    const d = list[i]!;
    const color = doorColor(ctx, data, d);
    const open = isOpen(d);
    const value = open ? (ctx.now - d.openSince! >= 60_000 ? ctx.fmt.duration(ctx.now - d.openSince!) : ctx.t(OPEN)) : d.stale ? ctx.fmt.ago(d.lastSeen) : ctx.t(CLOSED);
    drawRow(g, ctx, { x: row.x, y: row.y + pad, w: row.w, h: row.h - pad * 2 }, {
      icon: (x, y, s, col) => drawDoor(g, open, x, y, s, col),
      name: nameOf(ctx, d),
      nameColor: open ? color : d.stale ? ctx.theme.colors.inkFaint : ctx.theme.colors.ink,
      value,
      color,
      valueBold: open,
    });
  });
  drawMore(g, ctx, plan, {});
}

export const doors = defineWidget({
  id: 'doors',
  name: L('Doors', 'Puertas', 'Türen', '门窗', '門窗'),
  description: L(
    'SwitchBot contact sensors: the open doors and windows first, with how long they have been open, amber and then red when left open; a calm "All closed" when none is.',
    'Sensores de contacto SwitchBot: primero las puertas y ventanas abiertas, con cuánto tiempo llevan así, en ámbar y luego en rojo si se quedan abiertas; un tranquilo «Todo cerrado» cuando no hay ninguna.',
    'SwitchBot-Kontaktsensoren: offene Türen und Fenster zuerst, mit wie lange sie offen sind, gelb und dann rot, wenn sie offen bleiben; ein ruhiges „Alles zu“, wenn keine offen ist.',
    'SwitchBot 门窗传感器：开着的门窗排在最前，显示已开多久，忘关时先变琥珀色再变红色；全部关好时显示安静的“全部关好”。',
    'SwitchBot 門窗感測器：開著的門窗排在最前面，顯示已開多久，忘了關時先變琥珀色再變紅色；全部關好時顯示安靜的「全部關好」。',
  ),
  icon: 'door-open',
  category: 'info',
  tags: ['switchbot', 'door', 'window', 'contact', 'bluetooth'],
  size: { min: { w: 120, h: 24 }, preferred: { w: 320, h: 160 } },
  sources: [SOURCE],
  options: t.object({ devices: deviceFilter(), ...listOptions() }),
  redraw: 'minute',
  urgent: ({ sources, options, now }) => {
    const data = dataOf(sources);
    return !!data && doorsOf(data, options.devices).some((d) => isOpen(d) && now - d.openSince! >= data.openAlertMs);
  },
  idle: ({ sources, options }) => !doorsOf(dataOf(sources), options.devices).some(isOpen),
  empty: ({ sources, options }) => !!dataOf(sources) && !doorsOf(dataOf(sources), options.devices).some(isOpen),
  render(g, ctx) {
    const data = dataOf(ctx.sources);
    clipped(g, ctx, () => {
      if (!data) return drawMessage(g, ctx, ctx.t(WAITING));
      const list = sortDoors(doorsOf(data, ctx.options.devices));
      if (!list.length) return drawMessage(g, ctx, ctx.t(L('No door sensor heard', 'No se oye ningún sensor de puerta', 'Kein Türsensor gehört', '未收到门窗传感器', '沒收到門窗感測器')), { sub: noneHint(ctx, data) });
      const open = list.filter(isOpen);
      if (!open.length) {
        const stale = list.filter((d) => d.stale);
        const last = list.filter((d) => d.closedAt !== undefined && !d.stale).sort((a, b) => b.closedAt! - a.closedAt!)[0];
        const sub = stale.length
          ? ctx.plural(stale.length, { en: { one: '{n} not heard lately', other: '{n} not heard lately' }, es: { one: '{n} sin oírse últimamente', other: '{n} sin oírse últimamente' }, de: { one: '{n} länger nicht gehört', other: '{n} länger nicht gehört' }, 'zh-Hans': { other: '{n} 个最近没收到' }, 'zh-Hant': { other: '{n} 個最近沒收到' } })
          : last
            ? ctx.t(L('{name} closed {ago}', '{name}: cerrada {ago}', '{name} geschlossen {ago}', '{name}{ago}关上', '{name}{ago}關上')).replace('{name}', nameOf(ctx, last)).replace('{ago}', ctx.fmt.ago(last.closedAt!))
            : undefined;
        return drawMessage(g, ctx, ctx.t(L('All closed', 'Todo cerrado', 'Alles zu', '全部关好', '全部關好')), { check: true, ...(sub ? { sub } : {}) });
      }
      drawColumns(g, ctx, list, ctx.options.rows, (g2, c2, items) => drawDoorList(g2, c2, data, items, ctx.options.rows));
    });
  },
  demo,
});

/* Presence ---------------------------------------------------------------------------------- */

const sensorsOf = (data: SwitchBotData | undefined, filter: string[] | undefined) => pick(data, filter, (d) => d.kind === 'motion' || d.kind === 'presence');
const movingNow = (d: Device) => !!d.motion && !d.stale;

export function sortMotion(list: Device[]): Device[] {
  return [...list].sort((a, b) => Number(movingNow(b)) - Number(movingNow(a)) || (b.lastMotion ?? 0) - (a.lastMotion ?? 0));
}

const NOW = L('Now', 'Ahora', 'Jetzt', '有人', '有人');

function drawMotionList(g: Graphics, ctx: Ctx, list: Device[], rows: number): void {
  const { box, theme } = ctx;
  const c = theme.colors;
  const plan = listLayout(box, list.length, { rows }, { sizes: { 'one-line': { min: 20, max: ROW_MAX } } });
  const pad = Math.round(plan.rowH * 0.08);
  plan.rows.forEach((row, i) => {
    const d = list[i]!;
    const now = movingNow(d);
    let value: string;
    if (now) value = d.kind === 'presence' && d.presenceSince !== undefined && ctx.now - d.presenceSince >= 60_000 ? `${ctx.t(NOW)} · ${ctx.fmt.duration(ctx.now - d.presenceSince)}` : ctx.t(NOW);
    else if (d.lastMotion !== undefined) value = ctx.fmt.ago(d.lastMotion);
    else value = '–';
    const color = d.stale ? c.inkFaint : now ? c.accent : c.inkDim;
    drawRow(g, ctx, { x: row.x, y: row.y + pad, w: row.w, h: row.h - pad * 2 }, {
      icon: (x, y, s, col) => drawMotion(g, now, x, y, s, col),
      name: nameOf(ctx, d),
      nameColor: d.stale ? c.inkFaint : c.ink,
      value,
      color,
      valueBold: now,
    });
  });
  drawMore(g, ctx, plan, {});
}

export const presence = defineWidget({
  id: 'presence',
  name: L('Motion', 'Movimiento', 'Bewegung', '人体感应', '人體感應'),
  description: L(
    'SwitchBot motion and presence sensors: where someone is moving now, and when each saw someone last.',
    'Sensores de movimiento y de presencia SwitchBot: dónde se mueve alguien ahora y cuándo vio cada uno a alguien por última vez.',
    'SwitchBot-Bewegungs- und Anwesenheitssensoren: wo sich gerade jemand bewegt und wann jeder zuletzt jemanden gesehen hat.',
    'SwitchBot 人体与人在传感器：哪里现在有人活动，以及各自最后一次感应到人的时间。',
    'SwitchBot 人體與人在感測器：哪裡現在有人活動，以及各自最後一次感應到人的時間。',
  ),
  icon: 'activity',
  category: 'info',
  tags: ['switchbot', 'motion', 'presence', 'bluetooth'],
  size: { min: { w: 120, h: 24 }, preferred: { w: 320, h: 160 } },
  sources: [SOURCE],
  options: t.object({ devices: deviceFilter(), ...listOptions() }),
  redraw: 'minute',
  idle: ({ sources, options }) => !sensorsOf(dataOf(sources), options.devices).some(movingNow),
  empty: ({ sources, options }) => !!dataOf(sources) && sensorsOf(dataOf(sources), options.devices).length === 0,
  render(g, ctx) {
    const data = dataOf(ctx.sources);
    clipped(g, ctx, () => {
      if (!data) return drawMessage(g, ctx, ctx.t(WAITING));
      const list = sortMotion(sensorsOf(data, ctx.options.devices));
      if (!list.length) return drawMessage(g, ctx, ctx.t(L('No motion sensor heard', 'No se oye ningún sensor de movimiento', 'Kein Bewegungssensor gehört', '未收到人体传感器', '沒收到人體感測器')), { sub: noneHint(ctx, data) });
      drawColumns(g, ctx, list, ctx.options.rows, (g2, c2, items) => drawMotionList(g2, c2, items, ctx.options.rows));
    });
  },
  demo,
});

/* Batteries --------------------------------------------------------------------------------- */

type Severity = 'ok' | 'warn' | 'alert';

export function batterySeverity(d: Device, warn: number, alert: number): Severity {
  if (d.battery !== undefined) return d.battery <= alert ? 'alert' : d.battery <= warn ? 'warn' : 'ok';
  if (d.batteryRange === '<10') return 'alert';
  if (d.batteryRange === '10-19') return 'warn';
  return 'ok';
}

const withBattery = (data: SwitchBotData | undefined) => (data?.devices ?? []).filter((d) => d.battery !== undefined || d.batteryRange !== undefined);
const lowOnes = (data: SwitchBotData | undefined) =>
  data ? withBattery(data).filter((d) => batterySeverity(d, data.batteryWarn, data.batteryAlert) !== 'ok').sort((a, b) => (a.battery ?? 0) - (b.battery ?? 0)) : [];

const batteryText = (ctx: Ctx, d: Device) => (d.battery !== undefined ? pctText(ctx, d.battery) : d.batteryRange === '<10' ? '<10%' : d.batteryRange === '10-19' ? '10–19%' : '–');

function drawBatteryList(g: Graphics, ctx: Ctx, data: SwitchBotData, list: Device[], rows: number): void {
  const { box, theme } = ctx;
  const c = theme.colors;
  const plan = listLayout(box, list.length, { rows }, { sizes: { 'one-line': { min: 20, max: ROW_MAX } } });
  const pad = Math.round(plan.rowH * 0.08);
  plan.rows.forEach((row, i) => {
    const d = list[i]!;
    const s = batterySeverity(d, data.batteryWarn, data.batteryAlert);
    const color = s === 'alert' ? c.alert : s === 'warn' ? c.warn : c.inkDim;
    drawRow(g, ctx, { x: row.x, y: row.y + pad, w: row.w, h: row.h - pad * 2 }, {
      icon: (x, y, sz, col) => drawBattery(g, d.battery ?? 5, x, y, sz, col),
      name: nameOf(ctx, d),
      nameColor: s === 'ok' ? c.ink : color,
      value: batteryText(ctx, d),
      color,
    });
  });
  drawMore(g, ctx, plan, {});
}

export const batteries = defineWidget({
  id: 'batteries',
  name: L('SwitchBot batteries', 'Baterías SwitchBot', 'SwitchBot-Akkus', 'SwitchBot 电量', 'SwitchBot 電量'),
  description: L(
    'The SwitchBot sensors whose battery is running low, or a calm "Batteries OK" with the lowest one.',
    'Los sensores SwitchBot que se están quedando sin pila, o un tranquilo «Pilas bien» con la más baja.',
    'Die SwitchBot-Sensoren, deren Batterie zur Neige geht, oder ein ruhiges „Batterien OK“ mit der schwächsten.',
    '电量快用完的 SwitchBot 传感器，或安静的“电量正常”并显示最低的那个。',
    '電量快用完的 SwitchBot 感測器，或安靜的「電量正常」並顯示最低的那個。',
  ),
  icon: 'battery-low',
  category: 'info',
  tags: ['switchbot', 'battery', 'bluetooth'],
  size: { min: { w: 120, h: 24 }, preferred: { w: 320, h: 110 } },
  sources: [SOURCE],
  options: t.object({ ...listOptions() }),
  idle: ({ sources }) => lowOnes(dataOf(sources)).length === 0,
  empty: ({ sources }) => !!dataOf(sources) && lowOnes(dataOf(sources)).length === 0,
  urgent: ({ sources }) => {
    const data = dataOf(sources);
    return !!data && lowOnes(data).some((d) => batterySeverity(d, data.batteryWarn, data.batteryAlert) === 'alert');
  },
  render(g, ctx) {
    const data = dataOf(ctx.sources);
    clipped(g, ctx, () => {
      if (!data) return drawMessage(g, ctx, ctx.t(WAITING));
      const low = lowOnes(data);
      if (!low.length) {
        const all = withBattery(data).filter((d) => d.battery !== undefined).sort((a, b) => a.battery! - b.battery!);
        if (!all.length && !withBattery(data).length) return drawMessage(g, ctx, ctx.t(L('No SwitchBot heard', 'No se oye ningún SwitchBot', 'Kein SwitchBot gehört', '未收到 SwitchBot', '沒收到 SwitchBot')), { sub: noneHint(ctx, data) });
        const lowest = all[0];
        const sub = lowest ? ctx.t(L('Lowest: {name} {pct}', 'La más baja: {name} {pct}', 'Am schwächsten: {name} {pct}', '最低：{name} {pct}', '最低：{name} {pct}')).replace('{name}', nameOf(ctx, lowest)).replace('{pct}', batteryText(ctx, lowest)) : undefined;
        return drawMessage(g, ctx, ctx.t(L('Batteries OK', 'Pilas bien', 'Batterien OK', '电量正常', '電量正常')), { check: true, ...(sub ? { sub } : {}) });
      }
      drawColumns(g, ctx, low, ctx.options.rows, (g2, c2, items) => drawBatteryList(g2, c2, data, items, ctx.options.rows));
    });
  },
  demo,
});

export const WIDGETS = [climate, doors, presence, batteries];

/** For tests: the state functions with a given source data. */
export const stateOf = (data: SwitchBotData | undefined): Pick<StateContext<any, any>, 'sources'> => ({ sources: data ? { [SOURCE]: data } : {} });
