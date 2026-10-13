// Firefly Net v0.1 sync core (pure JS, no RN deps; mirrors ../../src/sim.js detect()).
export const DEFAULTS = {
  periodMs: 1000, flashMs: 120,
  coupling: 0.2,        // phase += coupling * phase on detection (Mirollo-Strogatz style)
  refractory: 0.25,     // ignore detections in first 25% of own cycle
  selfIgnoreMs: 350,    // ignore brightness spikes this long after own fire command (torch lag + exposure)
  minDelta: 6,          // min luma jump above baseline (0..255)
  kSigma: 4,            // or k * rolling std, whichever larger
  detectGapMs: 250,     // min time between detections
  baseAlpha: 0.05,      // baseline EMA rate
};

export class Detector {
  constructor(cfg = {}) { this.cfg = { ...DEFAULTS, ...cfg }; this.reset(); }
  reset() { this.base = null; this.var = 25; this.above = false; this.lastDet = -1e9; }
  // returns {spike, delta, threshold}; caller decides whether spike is own/external
  push(luma, t) {
    const c = this.cfg;
    if (this.base == null) { this.base = luma; return { spike: false, delta: 0, threshold: c.minDelta }; }
    const delta = luma - this.base, thr = Math.max(c.minDelta, c.kSigma * Math.sqrt(this.var));
    const isHigh = delta > thr;
    const rising = isHigh && !this.above && t - this.lastDet > c.detectGapMs;
    this.above = isHigh ? true : delta < thr * 0.5 ? false : this.above;
    if (!isHigh) { // only learn baseline from non-spike frames
      this.base += c.baseAlpha * delta; this.var += c.baseAlpha * (delta * delta - this.var);
    }
    if (rising) this.lastDet = t;
    return { spike: rising, delta, threshold: thr };
  }
}

export class Oscillator {
  constructor(cfg = {}, now = 0) { this.cfg = { ...DEFAULTS, ...cfg }; this.start = now - Math.random() * this.cfg.periodMs; this.lastFire = -1e9; this.nudges = 0; this.torchLagMs = 0; }
  phase(now) { return (now - this.start) / this.cfg.periodMs; }
  // call frequently; returns true when it is time to fire
  // fires early by own measured torch lag so the LIGHT (not the command) lands on phase 0
  tick(now) { const lag = this.torchLagMs; if (this.phase(now) >= 1 - lag / this.cfg.periodMs) { this.start = now + lag; this.lastFire = now; return true; } return false; }
  inSelfWindow(t) { return t - this.lastFire < this.cfg.selfIgnoreMs; }
  // external flash detected at time t (camera frame time); estMs = estimated pipeline delay
  onFlash(now, estMs = 0) {
    const c = this.cfg; let ph = this.phase(now) - estMs / c.periodMs; // phase when the flash actually happened
    if (ph < 0) ph += 1; // our own light is still pending (fire cmd sent): we're slightly behind -> treat as late phase
    if (ph < c.refractory) return false; // other is just behind us (or it's an echo): ignore
    const shift = Math.min(1 - ph, c.coupling * ph) * c.periodMs; // concave PRC jump, capped at "fire now"
    this.start -= shift; this.nudges++;
    return true;
  }
}
