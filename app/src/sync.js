// Firefly Net v0.2 sync core (pure JS, testable in node: node src/sync.test.mjs).
//
// TIME BASE: everything uses "perceived" time = the camera-frame time at which light shows up
// (frame.timestamp mapped onto the JS clock). Own echo lag L = torch cmd -> own light in a frame,
// so it includes the unknown camera capture latency C. An external flash is also seen C late,
// so C cancels when comparing "my light" vs "their light". Only TORCH lag differs between phones,
// and we correct that by firing the torch command L early.
export const DEFAULTS = {
  periodMs: 1000, flashMs: 120,
  coupling: 0.4,       // move next light this fraction of the measured offset toward the other flash
  refractory: 0.03,    // ignore flashes within 3% of anti-phase (ambiguous lead/lag)
  minDelta: 6, kSigma: 4, detectGapMs: 150, baseAlpha: 0.05,
  defaultLagMs: 150,
};

export const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const mad = (a) => { const m = median(a); return median(a.map(x => Math.abs(x - m))); };
export const wrapMs = (d, P) => ((d % P) + P * 1.5) % P - P / 2; // to (-P/2, P/2]

export class Detector { // rising-edge detector on frame mean luma vs rolling baseline
  constructor(cfg = {}) { this.cfg = { ...DEFAULTS, ...cfg }; this.reset(); }
  reset() { this.base = null; this.var = 25; this.above = false; this.lastDet = -1e9; }
  push(luma, t) {
    const c = this.cfg;
    if (this.base == null) { this.base = luma; return { spike: false, delta: 0, threshold: c.minDelta }; }
    const delta = luma - this.base, thr = Math.max(c.minDelta, c.kSigma * Math.sqrt(this.var));
    const isHigh = delta > thr, rising = isHigh && !this.above && t - this.lastDet > c.detectGapMs;
    this.above = isHigh ? true : delta < thr * 0.5 ? false : this.above;
    if (!isHigh) { this.base += c.baseAlpha * delta; this.var += c.baseAlpha * (delta * delta - this.var); }
    if (rising) this.lastDet = t;
    return { spike: rising, delta, threshold: thr };
  }
}

// Pearson correlation of luma samples [{t,l}] against the commanded on/off pattern shifted by L.
// cmds: [{t, on}] sorted. Returns {lag, r}.
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
export function makePattern(rand = Math.random, slots = 10) { // random bits, guaranteed mix of on/off and transitions
  for (;;) { const b = Array.from({ length: slots }, () => (rand() < 0.5 ? 1 : 0)); b[0] = 1; b[slots - 1] = 0;
    const ones = b.reduce((a, x) => a + x, 0), tr = b.slice(1).filter((x, i) => x !== b[i]).length;
    if (ones >= 3 && ones <= slots - 3 && tr >= 4) return b; }
}

export class Oscillator {
  // start = perceived time of our most recent (or already-commanded) own light.
  // adj   = correction to apply to the NEXT not-yet-commanded light (we can never fire in the past).
  constructor(cfg = {}, now = 0) { this.cfg = { ...DEFAULTS, ...cfg }; this.lagMs = this.cfg.defaultLagMs; this.start = now - Math.random() * this.cfg.periodMs; this.adj = 0; this.lastCmd = -1e9; this.nudges = 0; }
  phase(t) { const p = (t - this.start) / this.cfg.periodMs; return p - Math.floor(p); }
  nextLight() { return this.start + this.cfg.periodMs + this.adj; }
  // true when the torch command must go out now: L early, so our light lands on the planned grid
  tick(now) {
    if (now >= this.nextLight() - this.lagMs) { this.lastCmd = now; this.start = now + this.lagMs; this.adj = 0; return true; }
    return false;
  }
  expectedEcho() { return this.lastCmd + this.lagMs; }
  // signed offset (ms) of a perceived flash vs our planned light grid: + = they're later (we lead)
  offsetOf(tf) { return wrapMs(tf - (this.start + this.adj), this.cfg.periodMs); }
  // External flash perceived at tf. Phase-locking correction: move our next light a fraction
  // (coupling) of the way toward theirs. v0.1 used a Mirollo-Strogatz "fire now" jump, which can never
  // land on time when torch lag + detection delay (~150-300 ms) exceed the remaining gap -> the two
  // phones kept leapfrogging at a ~150-250 ms offset instead of locking.
  onFlash(tf) {
    const c = this.cfg, off = this.offsetOf(tf);
    if (Math.abs(off) > c.periodMs * (0.5 - c.refractory)) return 0; // near anti-phase: ambiguous, ignore
    const shift = c.coupling * off; this.adj = Math.max(-c.periodMs / 2, Math.min(c.periodMs / 2, this.adj + shift));
    this.nudges++; return shift;
  }
}
