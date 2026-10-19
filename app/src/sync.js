// Firefly Net v0.3 sync core (pure JS, unit-tested by `node src/sync.test.mjs`).
//
// Sync is now done over a radio channel (BLE adverts) instead of the camera:
// every phone advertises "time until my next planned flash" (ttf). A receiver turns each packet
// into an absolute estimate of the neighbour's next light (rxTimestamp + ttf - latency), compares it
// with its own planned light grid and, once per own flash, moves its grid part of the way toward the
// circular mean of its neighbours (consensus averaging). The camera is only used to measure the own
// torch lag (command -> light visible) so the torch command can be sent that much early.
// All times are in ms on ONE clock: Android SystemClock.elapsedRealtime (native module nowMs()).
export const DEFAULTS = {
  periodMs: 1000, flashMs: 100,
  k: 0.4,               // consensus gain per cycle
  maxStepMs: 150,       // clamp per-cycle correction
  windowMs: 700,        // use neighbour packets from the last 700 ms
  expireMs: 2000,       // forget neighbours not heard for 2 s
  bleLatencyMs: 50,     // mean packet staleness: payload updated every 100 ms, sent at random time after
  lockMs: 20,           // "locked" when RMS offset vs group mean < 20 ms
  minLeadMs: 15,        // never schedule a command closer than this to now
};

export const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const mad = (a) => { const m = median(a); return median(a.map(x => Math.abs(x - m))); };
export const wrapMs = (d, P) => ((d % P) + P * 1.5) % P - P / 2; // to [-P/2, P/2)
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function circMean(offs, P) { // returns {mean (ms, wrapped), R}
  if (!offs.length) return { mean: 0, R: 0 };
  let sx = 0, sy = 0; for (const o of offs) { const a = o / P * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
  return { mean: Math.atan2(sy, sx) / (2 * Math.PI) * P, R: Math.hypot(sx, sy) / offs.length };
}

// ---- BLE payload (12 bytes, manufacturer data 0xFFFF) — mirrored in the Kotlin module ----
// [0]=0x46 'F', [1]=0x03 version, [2..5]=id u32 LE, [6]=seq u8, [7..8]=ttf u16 LE ms, [9..10]=period u16 LE, [11]=flags
export function encodePayload({ id, seq, ttf, period, flags = 0 }) {
  const b = new Uint8Array(12); b[0] = 0x46; b[1] = 0x03;
  b[2] = id & 255; b[3] = (id >>> 8) & 255; b[4] = (id >>> 16) & 255; b[5] = (id >>> 24) & 255;
  b[6] = seq & 255; const t = clamp(Math.round(ttf), 0, 65535); b[7] = t & 255; b[8] = t >> 8; b[9] = period & 255; b[10] = period >> 8; b[11] = flags; return b;
}
export function decodePayload(b) {
  if (b.length < 12 || b[0] !== 0x46 || b[1] !== 0x03) return null;
  return { id: (b[2] | b[3] << 8 | b[4] << 16 | b[5] << 24) >>> 0, seq: b[6], ttf: b[7] | b[8] << 8, period: b[9] | b[10] << 8, flags: b[11] };
}
// time-until-next-flash at time `now` for a grid whose next planned light is `next`
export const ttfAt = (next, now, P) => { let t = (next - now) % P; if (t < 0) t += P; return t; };

// Drift-free flash scheduler: `next` = planned time of our next LIGHT. Command goes out lag ms early.
export class Scheduler {
  constructor(cfg = {}, now = 0, rand = Math.random) { this.cfg = { ...DEFAULTS, ...cfg }; this.lagMs = 0; this.next = now + 300 + rand() * this.cfg.periodMs; this.lastCmd = -1e9; this.lastPlanned = -1e9; this.lateness = 0; }
  due(now) { return now >= this.next - this.lagMs; }
  fire(now) { // call when due; returns planned light time of this flash
    const planned = this.next; this.lastCmd = now; this.lastPlanned = planned; this.lateness = now - (planned - this.lagMs);
    this.next = planned + this.cfg.periodMs; while (this.next - this.lagMs < now + this.cfg.minLeadMs) this.next += this.cfg.periodMs;
    return planned;
  }
  shift(ms, now) { // move the planned grid; never into the past
    const minNext = now + this.lagMs + this.cfg.minLeadMs; let s = ms;
    if (this.next + s < minNext) s = minNext - this.next;
    this.next += s; return s;
  }
}

// Per-neighbour estimates and consensus step.
export class Consensus {
  constructor(cfg = {}) { this.cfg = { ...DEFAULTS, ...cfg }; this.nb = new Map(); }
  reset() { this.nb.clear(); }
  // est = absolute estimate of the neighbour's next light (any grid point is fine)
  add(id, est, now, extra = {}) {
    let n = this.nb.get(id); if (!n) { n = { id, samples: [], rssiS: null, firstSeen: now, packets: 0 }; this.nb.set(id, n); }
    n.samples.push({ t: now, est }); n.last = now; n.packets++;
    if (extra.rssi != null) n.rssiS = n.rssiS == null ? extra.rssi : n.rssiS + (extra.rssi - n.rssiS) * 0.15; // EMA
    Object.assign(n, extra);
    const cut = now - this.cfg.windowMs; while (n.samples.length > 1 && n.samples[0].t < cut) n.samples.shift();
  }
  prune(now) { for (const [id, n] of this.nb) if (now - n.last > this.cfg.expireMs) this.nb.delete(id); }
  // neighbour offset vs reference light time `ref` (+ = neighbour flashes later than us)
  offsets(ref, now) {
    const P = this.cfg.periodMs, out = [];
    for (const n of this.nb.values()) {
      if (now - n.last > this.cfg.expireMs) continue;
      const s = n.samples.filter(x => now - x.t <= this.cfg.windowMs); if (!s.length) continue;
      // circular-safe median: unwrap around the first sample
      const o0 = wrapMs(s[0].est - ref, P), offs = s.map(x => o0 + wrapMs(x.est - ref - o0, P));
      out.push({ id: n.id, off: wrapMs(median(offs), P), n: s.length, rssi: n.rssiS, lastEst: s[s.length - 1].est, src: n.src });
    }
    return out;
  }
  // consensus correction for our grid (ref = our next planned light)
  step(ref, now) {
    const o = this.offsets(ref, now); if (!o.length) return { shift: 0, n: 0, mean: 0 };
    const { mean } = circMean(o.map(x => x.off), this.cfg.periodMs);
    // consensus x_i += k * (mean of neighbours - x_i); stable for 0 < k < 1
    return { shift: clamp(this.cfg.k * mean, -this.cfg.maxStepMs, this.cfg.maxStepMs), n: o.length, mean };
  }
  // group statistics incl. self: deviations from group circular mean, RMS error, order parameter R
  stats(ref, now) {
    const o = this.offsets(ref, now), P = this.cfg.periodMs, all = [0, ...o.map(x => x.off)];
    const { mean, R } = circMean(all, P), dev = all.map(v => wrapMs(v - mean, P));
    const err = Math.sqrt(dev.reduce((a, d) => a + d * d, 0) / all.length);
    return { n: o.length, mean, R, err: o.length ? err : NaN, self: dev[0], peers: o.map((x, i) => ({ ...x, dev: dev[i + 1] })) };
  }
}

// Camera echo detector for torch-lag tracking: first frame after the torch command whose brightness rises
// clearly above the median of the 250 ms BEFORE the command. Baseline never learns from lit frames.
export class EchoTracker {
  constructor() { this.frames = []; this.pending = null; this.samples = []; }
  frame(t, luma) { this.frames.push({ t, l: luma }); const cut = t - 1500; while (this.frames.length && this.frames[0].t < cut) this.frames.shift();
    const p = this.pending; if (!p) return null;
    if (t - p.cmd > 650) { this.pending = null; return { miss: true, cmd: p.cmd }; }
    if (t > p.cmd && luma - p.base > p.thr) { this.pending = null; const s = t - p.cmd; this.samples.push(s); if (this.samples.length > 15) this.samples.shift(); return { lag: s, cmd: p.cmd }; }
    return null; }
  command(t) { const pre = this.frames.filter(f => f.t > t - 250 && f.t <= t).map(f => f.l); if (pre.length < 2) { this.pending = null; return; }
    const base = median(pre), thr = Math.max(8, 5 * mad(pre), 0.15 * (255 - base)); this.pending = { cmd: t, base, thr }; }
  estimate() { return this.samples.length >= 3 ? { lag: median(this.samples), jitter: mad(this.samples), n: this.samples.length } : null; }
}

// Pearson correlation of luma samples [{t,l}] against the commanded on/off pattern shifted by L. -> {lag, r}
export function correlateLag(samples, cmds, maxLag = 600, step = 5) {
  const state = (t) => { let s = 0; for (const c of cmds) { if (c.t > t) break; s = c.on ? 1 : 0; } return s; };
  const n = samples.length; if (n < 10) return { lag: NaN, r: 0 };
  let ml = 0; for (const s of samples) ml += s.l; ml /= n; let vl = 0; for (const s of samples) vl += (s.l - ml) ** 2;
  let best = { lag: NaN, r: -1 };
  for (let L = 0; L <= maxLag; L += step) {
    let mp = 0; const p = samples.map(s => state(s.t - L)); for (const x of p) mp += x; mp /= n;
    let cov = 0, vp = 0; for (let i = 0; i < n; i++) { cov += (samples[i].l - ml) * (p[i] - mp); vp += (p[i] - mp) ** 2; }
    const r = vp > 0 && vl > 0 ? cov / Math.sqrt(vp * vl) : 0; if (r > best.r) best = { lag: L, r };
  }
  return best;
}
export function makePattern(rand = Math.random, slots = 10) {
  for (;;) { const b = Array.from({ length: slots }, () => (rand() < 0.5 ? 1 : 0)); b[0] = 1; b[slots - 1] = 0;
    const ones = b.reduce((a, x) => a + x, 0), tr = b.slice(1).filter((x, i) => x !== b[i]).length;
    if (ones >= 3 && ones <= slots - 3 && tr >= 4) return b; }
}
