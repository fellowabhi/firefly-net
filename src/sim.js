// Firefly Net core simulation: pulse-coupled oscillators (Mirollo-Strogatz style) with
// realistic phone flash/camera pipeline delays. DOM-free so it runs in Node too.
export const DEFAULTS = {
  seed: 42, n: 1500, iosRatio: 0.5, layout: 'bowl', // 'bowl' | 'grid'
  periodMs: 1000, flashMs: 120,
  radiusM: 25, fovDeg: 120, aimJitterDeg: 90, detectProb: 0.6, falsePerSec: 0.05,
  coupling: 0.12, refractory: 0.25, compensate: true,
  driftPpm: 100, jitterMs: 5,
  android: { torchMin: 30, torchMax: 250, fps: 30, procMin: 20, procMax: 80 },
  ios:     { torchMin: 30, torchMax: 120, fps: 60, procMin: 10, procMax: 40 },
};
export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
class Heap { constructor(){this.a=[];} push(e){const a=this.a;a.push(e);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(a[p].t<=a[i].t)break;[a[p],a[i]]=[a[i],a[p]];i=p;}}
  peek(){return this.a[0];} pop(){const a=this.a,top=a[0],last=a.pop();if(a.length){a[0]=last;let i=0;for(;;){let l=2*i+1,r=l+1,m=i;if(l<a.length&&a[l].t<a[m].t)m=l;if(r<a.length&&a[r].t<a[m].t)m=r;if(m===i)break;[a[m],a[i]]=[a[i],a[m]];i=m;}}return top;} get size(){return this.a.length;} }

export class Sim {
  constructor(cfg) {
    this.cfg = cfg = structuredClone({ ...DEFAULTS, ...cfg });
    const R = this.r = rng(cfg.seed), n = this.n = cfg.n;
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.ios = new Uint8Array(n);
    this.phase = new Float64Array(n); this.period = new Float64Array(n); this.cmdPhase = new Float64Array(n);
    this.cmdDone = new Uint8Array(n); this.lightOn = new Float64Array(n).fill(-1e9); this.lastFire = new Float64Array(n).fill(-1e9);
    this.frameOff = new Float64Array(n); this.pendFrame = new Float64Array(n).fill(-1); this.dir = new Float32Array(n * 2);
    this.lat = new Float64Array(n); this.fps = new Float64Array(n); this.procMin = new Float64Array(n); this.procMax = new Float64Array(n);
    const u = (a, b) => a + (b - a) * R();
    for (let i = 0; i < n; i++) {
      const ios = R() < cfg.iosRatio; this.ios[i] = ios; const p = ios ? cfg.ios : cfg.android;
      this.lat[i] = u(p.torchMin, p.torchMax); // device-specific mean torch latency
      this.fps[i] = p.fps; this.procMin[i] = p.procMin; this.procMax[i] = p.procMax;
      this.period[i] = cfg.periodMs * (1 + (R() * 2 - 1) * cfg.driftPpm * 1e-6);
      this.phase[i] = R(); this.frameOff[i] = R() * 1000 / p.fps;
      // self-calibration: phone measures its own torch latency and fires early by that much
      this.cmdPhase[i] = cfg.compensate ? 1 - this.lat[i] / this.period[i] : 1;
    }
    this.place(); this.aim(); this.buildNeighbors();
    this.t = 0; this.events = new Heap(); this.history = []; this.syncTime = null; this.flashes = 0; this.detections = 0; this.falseDet = 0;
  }
  place() {
    const { n, cfg, r: R } = this;
    if (cfg.layout === 'grid') {
      const cols = Math.ceil(Math.sqrt(n * 2)), sp = 1.2;
      for (let i = 0; i < n; i++) { this.x[i] = (i % cols) * sp + (R() - .5) * .4; this.y[i] = Math.floor(i / cols) * sp + (R() - .5) * .4; this.dir[2*i] = 0; this.dir[2*i+1] = -1; }
    } else { // elliptical seating bowl around a 105x68m pitch, stands from +8m to +45m
      const a = 60, b = 42;
      for (let i = 0; i < n; i++) {
        const th = R() * Math.PI * 2, d = 8 + R() * 37;
        const px = Math.cos(th) * (a + d), py = Math.sin(th) * (b + d);
        this.x[i] = px; this.y[i] = py; const L = Math.hypot(px, py); this.dir[2*i] = -px / L; this.dir[2*i+1] = -py / L;
      }
    }
  }
  aim() { // people don't all hold phones pointing at the pitch: rotate each camera by a random angle
    const j = this.cfg.aimJitterDeg * Math.PI / 180;
    for (let i = 0; i < this.n; i++) { const a = (this.r() * 2 - 1) * j, c = Math.cos(a), s = Math.sin(a), x = this.dir[2*i], y = this.dir[2*i+1];
      this.dir[2*i] = x * c - y * s; this.dir[2*i+1] = x * s + y * c; }
  }
  buildNeighbors() { // who can SEE whom: within radius and inside observer's camera cone
    const { n, x, y, dir, cfg } = this, rr = cfg.radiusM, cell = rr, grid = new Map(), cosF = Math.cos(cfg.fovDeg / 2 * Math.PI / 180);
    const key = (cx, cy) => cx * 100003 + cy;
    for (let i = 0; i < n; i++) { const k = key(Math.floor(x[i] / cell), Math.floor(y[i] / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    this.seenBy = Array.from({ length: n }, () => []); let total = 0;
    for (let j = 0; j < n; j++) { const cx = Math.floor(x[j] / cell), cy = Math.floor(y[j] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of grid.get(key(cx + dx, cy + dy)) || []) {
        if (i === j) continue; const vx = x[j] - x[i], vy = y[j] - y[i], d = Math.hypot(vx, vy);
        if (d > rr || d === 0) continue; if ((vx * dir[2*i] + vy * dir[2*i+1]) / d < cosF) continue;
        this.seenBy[j].push(i); total++; } }
    this.avgNeighbors = total / n;
  }
  fire(i) { // torch command issued; light appears after a random latency around device mean
    const lat = Math.max(5, this.lat[i] * (0.8 + 0.4 * this.r()) + (this.r() * 2 - 1) * this.cfg.jitterMs);
    this.events.push({ t: this.t + lat, type: 0, i });
  }
  scheduleDetect(obs, tOn) {
    const fp = 1000 / this.fps[obs], k = Math.ceil((tOn - this.frameOff[obs]) / fp), tf = this.frameOff[obs] + k * fp;
    if (tf > tOn + this.cfg.flashMs) return; if (this.pendFrame[obs] >= k) return; // one detection per frame
    if (this.r() > this.cfg.detectProb) return; this.pendFrame[obs] = k;
    const proc = this.procMin[obs] + (this.procMax[obs] - this.procMin[obs]) * this.r();
    this.events.push({ t: tf + proc, type: 1, i: obs, est: proc + fp / 2 });
  }
  detect(i, est) {
    const c = this.cfg; let ph = this.phase[i];
    if (ph < c.refractory) return; // just fired: ignore (likely own cluster / echo)
    // reachback: estimate phase at the time the flash actually happened, apply concave PRC jump
    if (c.compensate) ph = Math.max(0, ph - est / this.period[i]);
    this.phase[i] += c.coupling * ph;
    this.detections++;
  }
  step(dtMs) {
    const end = this.t + dtMs, h = 1, c = this.cfg;
    while (this.t < end) {
      const t1 = Math.min(end, this.t + h);
      while (this.events.size && this.events.peek().t <= t1) { const e = this.events.pop(); const tSave = this.t; this.t = e.t;
        if (e.type === 0) { this.lightOn[e.i] = e.t; this.flashes++; for (const o of this.seenBy[e.i]) this.scheduleDetect(o, e.t); }
        else this.detect(e.i, e.est); this.t = Math.max(tSave, e.t); }
      const dt = t1 - this.t, lam = c.falsePerSec * dt / 1000;
      for (let i = 0; i < this.n; i++) {
        if (lam > 0 && this.r() < lam) { this.falseDet++; this.detect(i, 30); }
        let p = this.phase[i] + dt / this.period[i];
        if (!this.cmdDone[i] && p >= this.cmdPhase[i]) { this.cmdDone[i] = 1; this.fire(i); }
        if (p >= 1) { p = 0; this.cmdDone[i] = 0; this.lastFire[i] = t1; if (this.cmdPhase[i] >= 1) this.fire(i); }
        this.phase[i] = p;
      }
      this.t = t1;
      if (Math.floor(this.t / 100) !== Math.floor((this.t - dt) / 100)) this.sample();
    }
  }
  metrics() { // order parameter + largest cluster of phones whose phases sit within ±5% of the period
    const n = this.n; let cs = 0, sn = 0; const B = 100, hist = new Uint32Array(B);
    for (let i = 0; i < n; i++) { const a = 2 * Math.PI * this.phase[i]; cs += Math.cos(a); sn += Math.sin(a); hist[Math.min(B - 1, Math.floor(this.phase[i] * B))]++; }
    let best = 0; const w = 10; for (let s = 0; s < B; s++) { let c = 0; for (let k = 0; k < w; k++) c += hist[(s + k) % B]; if (c > best) best = c; }
    // actual light alignment: circular std-dev of the most recent light-on times (ms)
    const P = this.cfg.periodMs; let c2 = 0, s2 = 0, m = 0;
    for (let i = 0; i < n; i++) if (this.t - this.lightOn[i] < 2 * P) { const a = 2 * Math.PI * (this.lightOn[i] % P) / P; c2 += Math.cos(a); s2 += Math.sin(a); m++; }
    const Rl = m ? Math.hypot(c2, s2) / m : 0, spread = Rl > 0 ? Math.sqrt(-2 * Math.log(Math.max(1e-9, Rl))) * P / (2 * Math.PI) : P;
    return { R: Math.hypot(cs, sn) / n, cluster: best / n, flashSpreadMs: spread };
  }
  sample() { const m = this.metrics(); this.history.push({ t: this.t, ...m }); if (this.syncTime === null && m.cluster >= 0.9) this.syncTime = this.t; return m; }
}
