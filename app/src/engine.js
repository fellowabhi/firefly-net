// Firefly Net v0.3 runtime engine: flash scheduler + sync channel (BLE / experimental audio) + torch-lag
// tracking + CSV logging. No React here; App.js renders engine.snapshot().
import N from '../modules/firefly-native';
import { DEFAULTS, Scheduler, Consensus, EchoTracker, correlateLag, makePattern, median, mad, wrapMs, ttfAt } from './sync';

export const VERSION = '0.3.0';
export const COLORS = ['#c8ff4d', '#5ad1ff', '#ff9f5a', '#d59bff', '#ff6b9a', '#6bffd8', '#ffe066', '#9db4ff'];
const P = DEFAULTS.periodMs;
const SCREEN_LAG_MS = 40;      // setState -> vsync -> panel, rough estimate for screen output
const DEFAULT_TORCH_LAG = 150;
const AUDIO_FREQ = 18000, AUDIO_CHIRP_MS = 30, AUDIO_THR = 12;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (v) => typeof v === 'number' ? (Number.isInteger(v) ? v : +v.toFixed(2)) : `"${String(v).replace(/"/g, '""')}"`;

export class Engine {
  constructor(hooks) {
    this.h = hooks; // { torch(on) -> Promise, screenFlash(), lockExposure() -> Promise<string>, cameraReady() -> bool }
    this.channel = 'ble'; this.output = 'torch';
    this.torchLag = null; this.torchLagSrc = 'not calibrated'; this.torchJitter = null; this.calib = [];
    this.running = false; this.csv = []; this.ui = []; this.subs = [];
    this.names = new Map(); this.peerHist = [];
  }
  now() { return N.nowMs(); }
  log(type, ...v) { if (this.csv.length < 300000) this.csv.push(`${this.now().toFixed(1)},${type},${v.map(fmt).join(',')}`); }
  show(cls, msg) { const d = new Date(); this.ui.push({ ts: d.toTimeString().slice(3, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'), cls, msg }); if (this.ui.length > 60) this.ui.shift(); }
  nameOf(id) { if (id === 'AUD') return 'Audio'; if (!this.names.has(id)) { const i = this.names.size; this.names.set(id, { name: String.fromCharCode(66 + (i % 25)), color: COLORS[1 + (i % (COLORS.length - 1))] }); } return this.names.get(id); }

  async start() {
    if (this.running) this.stop();
    this.running = true; this.sess = (this.sess || 0) + 1; this.t0 = this.now(); this.id = (Math.random() * 4294967295) >>> 0;
    this.csv = [`# Firefly Net v${VERSION} log, started ${new Date().toISOString()}, clock=elapsedRealtime ms, my id=${this.id}`,
      '# columns: t_ms,type,values... | adv_rx: id,name,seq,rssi,radioToJsMs,ttf,estLightOffsetMs | nudge: shiftMs,nPeers,meanOffMs,errMs | cmd: on,lagMs,latenessMs,plannedLight | ' +
      'light_planned: t | echo: lagSampleMs,lagMs | echo_miss: cmd | calib: run,lagMs,r | torch_ack: on,apiMs | torch_err: msg | chirp_rx: t,snrDb,kind,offsetMs | chirp_out: t | channel: name | output: name | status: kind,msg'];
    this.ui = []; this.names = new Map(); this.peerHist = []; this.cmdHist = []; this.lightHist = []; this.nudgeHist = []; this.rxTimes = []; this.spread = [];
    this.locked = false; this.lastNudge = 0; this.warn = ''; this.echo = new EchoTracker(); this.loop = []; this.mode = 'starting';
    this.sched = new Scheduler({}, this.now()); this.cons = new Consensus();
    this.show('sy', `session start · id ${this.id.toString(16)} · channel ${this.channel.toUpperCase()}`); this.log('channel', this.channel); this.log('output', this.output);
    this.subs.push(N.addListener('onStatus', e => { this.log('status', e.kind, e.msg); this.show(e.kind.includes('error') ? 'er' : 'sy', e.msg); if (e.kind.includes('error')) this.warn = e.msg; }));
    this.subs.push(N.addListener('onAdv', e => this.onAdv(e)));
    this.subs.push(N.addListener('onChirp', e => this.onChirp(e)));
    this.subs.push(N.addListener('onChirpOut', e => { this.log('chirp_out', e.t); }));
    const sess = this.sess;
    if (this.output === 'torch' && this.torchLag == null) await this.calibrate();
    if (!this.running || sess !== this.sess) return;
    this.applyLag(); this.startChannel(); this.mode = 'run';
    this.loopT = setInterval(() => this.tick(), 3);
  }
  stop() {
    this.running = false; clearInterval(this.loopT); clearTimeout(this.offT); this.subs.forEach(s => s.remove()); this.subs = [];
    try { N.stopBle(); N.stopAudio(); } catch (e) {}
    if (this.output === 'torch') this.h.torch(false);
  }
  applyLag() { this.sched.lagMs = this.output === 'torch' ? (this.torchLag ?? DEFAULT_TORCH_LAG) : SCREEN_LAG_MS; }
  startChannel() {
    N.setSchedule(this.sched.next, P, 0);
    if (this.channel === 'ble') { const r = N.startBle(this.id, 100); this.log('status', 'ble_start', r); this.show(r === 'ok' ? 'sy' : 'er', r === 'ok' ? 'BLE advertising + scanning (100 ms)' : 'BLE: ' + r); if (r !== 'ok') this.warn = 'Bluetooth: ' + r; }
    else { const r = N.startAudio(AUDIO_FREQ, AUDIO_CHIRP_MS, AUDIO_THR); this.audioT0 = this.now(); this.log('status', 'audio_start', r); this.show(r === 'ok' ? 'sy' : 'er', r === 'ok' ? `audio chirps ${AUDIO_FREQ / 1000} kHz (experimental)` : 'audio: ' + r); }
  }
  setChannel(ch) { if (ch === this.channel) return; this.channel = ch; this.log('channel', ch); this.show('sy', `channel → ${ch.toUpperCase()}`);
    if (this.mode === 'run') { N.stopBle(); N.stopAudio(); this.cons.reset(); this.loop = []; this.startChannel(); } }
  async setOutput(o) { if (o === this.output) return; if (this.output === 'torch') this.h.torch(false); this.output = o; this.log('output', o); this.show('sy', `flash output → ${o}`);
    if (o === 'torch' && this.torchLag == null && this.mode === 'run') { this.mode = 'calib'; await this.calibrate(); this.mode = 'run'; } this.applyLag(); }

  // ---- camera frames (torch mode): torch-lag calibration + continuous echo tracking ----
  frame(tf, luma) {
    if (this.calSamples) this.calSamples.push({ t: tf, l: luma });
    const r = this.echo.frame(tf, luma);
    if (r?.lag != null) { const est = this.echo.estimate(); this.log('echo', r.lag, est?.lag ?? -1);
      if (est && est.n >= 5) { this.torchLag = est.lag; this.torchJitter = est.jitter; this.torchLagSrc = `camera echo (n=${est.n})`; this.applyLag(); } }
    else if (r?.miss) this.log('echo_miss', r.cmd);
  }
  async calibrate() {
    const sess = this.sess, alive = () => this.running && sess === this.sess;
    this.mode = 'calib'; this.show('cb', 'calibrating torch lag: point camera at a wall/ceiling');
    for (let i = 0; i < 50 && !this.h.ready() && alive(); i++) await sleep(100); // wait for camera controller
    await sleep(1200); if (!alive()) return;
    const ae = await this.h.lockExposure(); this.log('status', 'exposure', ae); this.show('cb', 'exposure: ' + ae);
    this.calib = [];
    for (let k = 0; k < 4 && alive(); k++) {
      const bits = makePattern(), cmds = []; this.calSamples = []; const t0 = this.now();
      for (let i = 0; i < bits.length; i++) { const target = t0 + i * 100; await sleep(Math.max(0, target - this.now()));
        if (i === 0 || bits[i] !== bits[i - 1]) { cmds.push({ t: this.now(), on: bits[i] }); this.h.torch(!!bits[i]); } }
      await sleep(Math.max(0, t0 + 1000 - this.now())); cmds.push({ t: this.now(), on: 0 }); this.h.torch(false);
      await sleep(800);
      const res = correlateLag(this.calSamples.filter(x => x.t > t0 - 100), cmds); this.calSamples = null;
      this.calib.push(res); this.log('calib', k, res.lag, res.r); this.show('cb', `calib ${k + 1}/4: lag ${res.lag} ms, match ${res.r.toFixed(2)}`);
      await sleep(250);
    }
    if (!alive()) return;
    const good = this.calib.filter(c => c.r >= 0.6).map(c => c.lag);
    if (good.length >= 2) { this.torchLag = median(good); this.torchJitter = mad(good); this.torchLagSrc = `calibration ${good.length}/4`; this.warn = ''; this.show('cb', `torch lag = ${this.torchLag} ms (σ≈${this.torchJitter.toFixed(0)})`); }
    else { this.torchLag = null; this.torchLagSrc = 'default (calibration failed)'; this.warn = 'Point camera at a wall/ceiling for calibration (own flash not visible). Using 150 ms.'; this.show('er', 'calibration failed → default 150 ms'); }
    this.log('calib_result', this.torchLag ?? -1, this.torchLagSrc);
  }

  // ---- flash loop ----
  tick() {
    const now = this.now(), s = this.sched;
    if (this.mode !== 'run' || !s.due(now)) return;
    const planned = s.fire(now);
    this.log('cmd', 1, s.lagMs, s.lateness, planned); this.cmdHist.push(now); this.lightHist.push(planned);
    if (this.output === 'torch') { this.h.torch(true); this.echo.command(now); clearTimeout(this.offT); this.offT = setTimeout(() => { this.h.torch(false); this.log('cmd', 0, s.lagMs, 0, planned); }, DEFAULTS.flashMs); }
    else this.h.screenFlash(s.lagMs);
    // consensus once per cycle, toward neighbours' estimated grids
    this.cons.prune(now);
    const st = this.cons.step(s.next, now);
    for (const o of this.cons.offsets(s.next, now)) this.peerHist.push({ id: o.id, t: planned + o.off });
    if (st.n) { const applied = s.shift(st.shift, now); this.lastNudge = applied; this.nudgeHist.push({ t: now, v: applied });
      const g = this.cons.stats(s.next, now); this.log('nudge', applied, st.n, st.mean, g.err);
      if (Math.abs(applied) > 1.5 || Math.random() < 0.2) this.show('nd', `nudge ${applied >= 0 ? '+' : '−'}${Math.abs(applied).toFixed(1)}ms  (n=${st.n}, k=${DEFAULTS.k})`); }
    N.setSchedule(s.next, P, this.locked ? 1 : 0);
    const cut = now - 7000; for (const a of [this.cmdHist, this.lightHist]) while (a.length && a[0] < cut) a.shift();
    while (this.nudgeHist.length && this.nudgeHist[0].t < cut) this.nudgeHist.shift(); while (this.peerHist.length && this.peerHist[0].t < cut) this.peerHist.shift();
  }

  // ---- BLE rx ----
  onAdv(e) {
    if (!this.running || e.period !== P) return;
    const now = this.now(), est = e.ts + e.ttf - DEFAULTS.bleLatencyMs, id = e.id, nm = this.nameOf(id);
    this.cons.add(id, est, now, { rssi: e.rssi, src: 'ble' }); this.rxTimes.push(now);
    const off = wrapMs(est - this.sched.next, P);
    this.log('adv_rx', id, nm.name, e.seq, e.rssi, e.rx - e.ts, e.ttf, off);
    if (!this.lastRxShow || now - this.lastRxShow > 450) { this.lastRxShow = now; this.show('rx', `rx ${nm.name} adv ttf=${e.ttf} rssi ${e.rssi} Δ${off >= 0 ? '+' : '−'}${Math.abs(off).toFixed(0)}ms`); }
  }
  // ---- audio rx (experimental): own chirps measure the loop delay, others become neighbour 'AUD' ----
  onChirp(e) {
    if (!this.running || this.channel !== 'audio') return;
    const now = this.now(), s = this.sched, gridNear = s.next + Math.round((e.t - s.next) / P) * P;
    const rel = e.t - gridNear, loop = this.loop.length >= 3 ? median(this.loop) : null;
    let kind;
    if ((loop == null && now - this.audioT0 < 4000 && rel > -10 && rel < 150) || (loop != null && Math.abs(rel - loop) < 25)) { kind = 'own'; this.loop.push(rel); if (this.loop.length > 15) this.loop.shift(); }
    else if (loop != null) { kind = 'ext'; const est = e.t - loop; this.cons.add('AUD', est, now, { src: 'audio', rssi: null }); this.rxTimes.push(now); }
    else kind = 'ignored';
    const off = loop != null ? wrapMs(e.t - loop - s.next, P) : 0;
    this.log('chirp_rx', e.t, e.snr, kind, off);
    if (kind !== 'own' || Math.random() < 0.1) this.show('rx', `chirp ${kind} snr ${e.snr.toFixed(0)}dB${kind === 'ext' ? ` Δ${off >= 0 ? '+' : '−'}${Math.abs(off).toFixed(0)}ms` : kind === 'own' ? ` loop ${rel.toFixed(0)}ms` : ''}`);
  }

  snapshot() {
    const now = this.now(), s = this.sched; if (!s) return null;
    const g = this.cons.stats(s.next, now);
    if (!this.spreadAt || now - this.spreadAt > 200) { this.spreadAt = now; if (isFinite(g.err)) this.spread.push({ t: now, v: g.err }); while (this.spread.length && this.spread[0].t < now - 30000) this.spread.shift(); }
    if (isFinite(g.err)) { if (!this.locked && g.err < DEFAULTS.lockMs) { this.locked = true; this.show('sy', `LOCKED ±${g.err.toFixed(0)}ms R=${g.R.toFixed(3)}`); this.log('status', 'locked', g.err); }
      else if (this.locked && g.err > DEFAULTS.lockMs * 2.5) { this.locked = false; this.show('sy', 'lock lost → resync'); this.log('status', 'lock_lost', g.err); } }
    else if (this.locked) this.locked = false;
    while (this.rxTimes.length && this.rxTimes[0] < now - 1000) this.rxTimes.shift();
    const lastLight = this.lightHist.filter(t => t <= now).pop() ?? -1e9;
    const peers = g.peers.map(p => { const nm = this.nameOf(p.id); let ll = p.lastEst; ll -= Math.ceil((ll - now) / P) * P; return { ...p, ...nm, lastLight: ll }; });
    const rss = peers.filter(p => p.rssi != null).map(p => p.rssi);
    return { now, t: (now - this.t0) / 1000, mode: this.mode, locked: this.locked, err: g.err, R: g.R, selfDev: g.self, peers, lastLight,
      cmdHist: this.cmdHist, lightHist: this.lightHist, nudgeHist: this.nudgeHist, peerHist: this.peerHist, spread: this.spread,
      pps: this.rxTimes.length, avgRssi: rss.length ? rss.reduce((a, b) => a + b, 0) / rss.length : null, lastNudge: this.lastNudge,
      lag: s.lagMs, lagSrc: this.output === 'torch' ? this.torchLagSrc : 'screen estimate', jitter: this.torchJitter, loop: this.loop.length ? median(this.loop) : null,
      channel: this.channel, output: this.output, warn: this.warn, ui: this.ui, calib: this.calib };
  }
  csvText() { return this.csv.join('\n'); }
}
