// node src/sync.test.mjs — unit tests + BLE consensus simulation for Firefly Net v0.3 sync core.
import assert from 'node:assert/strict';
import { Scheduler, Consensus, EchoTracker, encodePayload, decodePayload, ttfAt, wrapMs, circMean, correlateLag, makePattern, median } from './sync.js';
let rs = 7; const R = () => (rs = (rs * 1103515245 + 12345) % 2147483648) / 2147483648;

// payload round trip
const p = { id: 0xDEADBEEF, seq: 201, ttf: 734, period: 1000, flags: 1 };
assert.deepEqual(decodePayload(encodePayload(p)), p);
assert.equal(ttfAt(1500, 1200, 1000), 300); assert.equal(ttfAt(1500, 1700, 1000), 800);
assert.equal(wrapMs(990, 1000), -10); assert.ok(Math.abs(circMean([490, -490], 1000).mean) > 400); // wrap-safe mean
// scheduler: drift-free (planned grid exactly P apart even with late commands) + lag compensation
{ const s = new Scheduler({}, 0, () => 0); s.lagMs = 200; const planned = [];
  for (let t = 0; t < 5000; t++) if (s.due(t)) { planned.push(s.fire(t + 7)); } // 7 ms JS lateness every time
  const d = planned.slice(1).map((x, i) => x - planned[i]); assert.ok(d.every(x => x === 1000), 'grid drift-free'); }
// echo tracker
{ const e = new EchoTracker(); let t = 0; for (; t < 500; t += 66) e.frame(t, 20 + R()); e.command(t);
  let res = null; for (let k = 0; k < 10 && !res; k++) { t += 66; res = e.frame(t, t > 500 + 180 ? 150 : 21); }
  assert.ok(res && res.lag > 150 && res.lag < 260, 'echo lag ' + JSON.stringify(res)); }
// calibration correlation
{ const bits = makePattern(R), cmds = bits.map((b, i) => ({ t: i * 100, on: b })); cmds.push({ t: 1000, on: 0 });
  const st = t => { let s = 0; for (const c of cmds) { if (c.t > t - 230) break; s = c.on; } return s; };
  const smp = []; for (let t = 0; t < 1800; t += 60) smp.push({ t, l: 30 + 100 * st(t) + R() * 5 });
  const r = correlateLag(smp, cmds); assert.ok(Math.abs(r.lag - 230) <= 35 && r.r > 0.8, 'calib ' + JSON.stringify(r)); }
console.log('unit tests ok');

// ---- BLE consensus simulation: N phones, real torch lags, staleness, loss, clock drift, JS lateness ----
function simulate(N, { loss = 0.2, secs = 40, lagErr = 15 } = {}) {
  const P = 1000, ph = Array.from({ length: N }, (_, i) => {
    const torch = 80 + R() * 220; const s = new Scheduler({}, 0, R); s.lagMs = torch + (R() - .5) * 2 * lagErr; // calibrated lag (with error)
    return { i, torch, s, c: new Consensus(), drift: 1 + (R() - .5) * 1e-4, lights: [], lastUpd: 0, payload: null }; });
  const air = []; let firstLock = null;
  for (let t = 0; t < secs * 1000; t++) {
    for (const q of ph) {
      const now = t * q.drift; // phone-local clock
      if (q.s.due(now)) { const late = R() * 12; q.s.fire(now + late); q.lights.push(t + late / q.drift + q.torch); // real light (global time)
        const st = q.c.step(q.s.next, now); q.s.shift(st.shift, now); q.c.prune(now); }
      if (t - q.lastUpd >= 100) { q.lastUpd = t; q.payload = { ttf: Math.round(ttfAt(q.s.next, now, P)), setAt: t };
        // packet goes on air at a random time in the next 100 ms, carrying the (stale) ttf
        const tx = t + R() * 100; for (const r of ph) if (r !== q && R() > loss) air.push({ at: tx + 0.5, to: r, ttf: q.payload.ttf, from: q.i, setAt: t }); }
    }
    for (let k = air.length - 1; k >= 0; k--) { const a = air[k]; if (a.at <= t) { const now = t * a.to.drift; // receiver: ts = rx time
        a.to.c.add(a.from, now + a.ttf - 50, now); air.splice(k, 1); } }
    if (!firstLock && t > 3000 && t % 500 === 0) { const last = ph.map(q => q.lights[q.lights.length - 1]); const m = circMean(last.map(x => x % P), P).mean;
      const err = Math.sqrt(last.reduce((a, x) => a + wrapMs(x - m, P) ** 2, 0) / N); if (err < 20) firstLock = t; }
  }
  const last = ph.map(q => q.lights.slice(-5)), spreads = [0, 1, 2, 3].map(k => { const v = last.map(l => l[k] % P), m = circMean(v, P).mean; return Math.sqrt(v.reduce((a, x) => a + wrapMs(x - m, P) ** 2, 0) / N); });
  return { N, lockAt: firstLock, rmsMs: +median(spreads).toFixed(1) };
}
for (const N of [2, 5, 20]) { const r = simulate(N); console.log('sim', r); assert.ok(r.rmsMs < 20, `N=${N} not locked: ${r.rmsMs}`); }
console.log('all tests ok');
