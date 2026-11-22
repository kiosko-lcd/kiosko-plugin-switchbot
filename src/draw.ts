/**
 * Icons, the trend arrow and the sparkline, drawn with canvas paths (the
 * panel's fonts have no emoji). Every icon fits the square (x, y, s).
 */
import type { Graphics } from '@kiosko/sdk';

function rr(g: Graphics, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + k, y);
  g.lineTo(x + w - k, y);
  g.arcTo(x + w, y, x + w, y + k, k);
  g.lineTo(x + w, y + h - k);
  g.arcTo(x + w, y + h, x + w - k, y + h, k);
  g.lineTo(x + k, y + h);
  g.arcTo(x, y + h, x, y + h - k, k);
  g.lineTo(x, y + k);
  g.arcTo(x, y, x + k, y, k);
  g.closePath();
}

function pen(g: Graphics, s: number, color: string): void {
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = Math.max(1.2, s * 0.09);
  g.lineCap = 'round';
  g.lineJoin = 'round';
}

/** A door: closed, a rectangle with its handle; open, the leaf swung out of its frame. */
export function drawDoor(g: Graphics, open: boolean, x: number, y: number, s: number, color: string): void {
  g.save();
  pen(g, s, color);
  const u = s / 24;
  const X = (v: number) => x + v * u;
  const Y = (v: number) => y + v * u;
  if (!open) {
    rr(g, X(6), Y(2.5), 12 * u, 19 * u, 1 * u);
    g.stroke();
    g.beginPath();
    g.arc(X(15), Y(12.5), 1.1 * u, 0, Math.PI * 2);
    g.fill();
  } else {
    // The frame, and the leaf turned towards us.
    g.beginPath();
    g.moveTo(X(5), Y(21.5));
    g.lineTo(X(5), Y(2.5));
    g.lineTo(X(19), Y(2.5));
    g.lineTo(X(19), Y(21.5));
    g.stroke();
    g.beginPath();
    g.moveTo(X(5), Y(2.5));
    g.lineTo(X(13), Y(5));
    g.lineTo(X(13), Y(23.5));
    g.lineTo(X(5), Y(21.5));
    g.closePath();
    g.globalAlpha = 0.35;
    g.fill();
    g.globalAlpha = 1;
    g.stroke();
    g.beginPath();
    g.arc(X(11), Y(13.5), 1.1 * u, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** A person, with motion waves when `moving`. */
export function drawMotion(g: Graphics, moving: boolean, x: number, y: number, s: number, color: string): void {
  g.save();
  pen(g, s, color);
  const u = s / 24;
  const X = (v: number) => x + v * u;
  const Y = (v: number) => y + v * u;
  g.beginPath();
  g.arc(X(10), Y(4.5), 2.2 * u, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(X(10), Y(8));
  g.lineTo(X(9), Y(14.5));
  g.lineTo(X(5.5), Y(21));
  g.moveTo(X(9), Y(14.5));
  g.lineTo(X(12.5), Y(17));
  g.lineTo(X(13), Y(21.5));
  g.moveTo(X(5.5), Y(11.5));
  g.lineTo(X(10), Y(9));
  g.lineTo(X(14), Y(12));
  g.stroke();
  if (moving) {
    g.beginPath();
    g.arc(X(13), Y(12), 5.5 * u, -0.6, 0.6);
    g.stroke();
    g.beginPath();
    g.arc(X(13), Y(12), 9 * u, -0.55, 0.55);
    g.stroke();
  }
  g.restore();
}

/** A thermometer. */
export function drawThermometer(g: Graphics, x: number, y: number, s: number, color: string): void {
  g.save();
  pen(g, s, color);
  const u = s / 24;
  const X = (v: number) => x + v * u;
  const Y = (v: number) => y + v * u;
  g.beginPath();
  g.moveTo(X(10), Y(15));
  g.lineTo(X(10), Y(4.5));
  g.arc(X(12), Y(4.5), 2 * u, Math.PI, 0);
  g.lineTo(X(14), Y(15));
  g.arc(X(12), Y(18), 3.6 * u, -Math.PI / 2 + 0.6, Math.PI * 1.5 - 0.6);
  g.closePath();
  g.stroke();
  g.beginPath();
  g.arc(X(12), Y(18), 1.6 * u, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** A battery, filled to `level` (0..100). */
export function drawBattery(g: Graphics, level: number, x: number, y: number, s: number, color: string): void {
  g.save();
  pen(g, s, color);
  const u = s / 24;
  rr(g, x + 2 * u, y + 7 * u, 17 * u, 10 * u, 2 * u);
  g.stroke();
  g.fillRect(x + 20 * u, y + 10 * u, 2 * u, 4 * u);
  const fw = (13 * u * Math.max(0, Math.min(100, level))) / 100;
  if (fw > 0) g.fillRect(x + 4 * u, y + 9 * u, Math.max(u, fw), 6 * u);
  g.restore();
}

/** A check mark in a circle, for the calm states. */
export function drawCheck(g: Graphics, x: number, y: number, s: number, color: string): void {
  g.save();
  pen(g, s, color);
  g.beginPath();
  g.arc(x + s / 2, y + s / 2, s * 0.42, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(x + s * 0.3, y + s * 0.52);
  g.lineTo(x + s * 0.45, y + s * 0.66);
  g.lineTo(x + s * 0.71, y + s * 0.38);
  g.stroke();
  g.restore();
}

/** An arrow up or down (a filled triangle with a stem) in the box (x, y, w, h). */
export function drawTrend(g: Graphics, dir: 'up' | 'down', x: number, y: number, w: number, h: number, color: string): void {
  g.save();
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineWidth = Math.max(1.5, w * 0.22);
  g.lineCap = 'round';
  const cx = x + w / 2;
  const head = h * 0.5;
  g.beginPath();
  if (dir === 'up') {
    g.moveTo(cx, y);
    g.lineTo(x + w, y + head);
    g.lineTo(x, y + head);
  } else {
    g.moveTo(cx, y + h);
    g.lineTo(x + w, y + h - head);
    g.lineTo(x, y + h - head);
  }
  g.closePath();
  g.fill();
  g.beginPath();
  if (dir === 'up') {
    g.moveTo(cx, y + head * 0.9);
    g.lineTo(cx, y + h);
  } else {
    g.moveTo(cx, y + h - head * 0.9);
    g.lineTo(cx, y);
  }
  g.stroke();
  g.restore();
}

/**
 * A line of the values in the box, scaled to their own range (at least
 * `minRange`, so a steady room is a calm line, not noise blown up), with a
 * faint area under it. Gaps (null) break the line.
 */
export function drawSparkline(g: Graphics, values: (number | null)[], x: number, y: number, w: number, h: number, o: { color: string; area: string; minRange: number; lineWidth?: number }): void {
  const real = values.filter((v): v is number => v != null);
  if (real.length < 2 || w < 4 || h < 4) return;
  let lo = Math.min(...real);
  let hi = Math.max(...real);
  if (hi - lo < o.minRange) {
    const mid = (hi + lo) / 2;
    lo = mid - o.minRange / 2;
    hi = mid + o.minRange / 2;
  }
  const lw = o.lineWidth ?? Math.max(1.5, h * 0.06);
  const top = y + lw;
  const span = h - lw * 2;
  const px = (i: number) => x + (values.length === 1 ? w : (i / (values.length - 1)) * w);
  const py = (v: number) => top + span - ((v - lo) / (hi - lo)) * span;
  // Runs of values without gaps.
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push([px(i), py(v)]);
  });
  if (run.length) runs.push(run);
  g.save();
  for (const r of runs) {
    if (r.length < 2) continue;
    g.beginPath();
    g.moveTo(r[0]![0], y + h);
    for (const [a, b] of r) g.lineTo(a, b);
    g.lineTo(r[r.length - 1]![0], y + h);
    g.closePath();
    g.fillStyle = o.area;
    g.fill();
    g.beginPath();
    r.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b)));
    g.strokeStyle = o.color;
    g.lineWidth = lw;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
  }
  g.restore();
}
