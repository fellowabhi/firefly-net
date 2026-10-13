// node src/sync.test.mjs : 2 simulated phones with different torch lags, camera latency, frame quantization, jitter.
import { Oscillator, Detector, correlateLag, makePattern, median } from './sync.js';
const P = 1000, phones = [
  { torch: 180, tj: 40, cam: 45, fps: 30 }, { torch: 70, tj: 15, cam: 60, fps: 30 }];
const R = Math.random;
// --- calibration: correlate own pattern with simulated luma ---
for (const ph of phones) {
  const lags = [];
  for (let k = 0; k < 3; k++) { const bits = makePattern(); const cmds = bits.map((b, i) => ({ t: i * 100, on: b })); cmds.push({ t: 1000, on: 0 });
    const real = cmds.map(c => ({ t: c.t + ph.torch + (R() - .5) * ph.tj, on: c.on }));
    const st = t => { let s = 0; for (const c of real) { if (c.t > t) break; s = c.on; } return s; };
    const samples = []; for (let t = 0; t < 1800; t += 1000 / ph.fps) samples.push({ t: t + ph.cam, l: 80 + 30 * st(t) + R() * 3 + (R() < 0.05 ? 25 : 0) });
    lags.push(correlateLag(samples, cmds).lag); }
  ph.L = median(lags); console.log(`calib: true torch+cam ${ph.torch + ph.cam} ms, estimated ${ph.L} ms (runs ${lags})`);
}
// --- run ---
const os = phones.map((p, i) => { const o = new Oscillator({}, 0); o.lagMs = p.L; o.start = i ? -430 : 0; return o; });
const lights = [[], []], pend = [];
for (let t = 0; t < 40000; t++) {
  os.forEach((o, i) => { if (o.tick(t)) { const lt = t + phones[i].torch + (R() - .5) * phones[i].tj; lights[i].push(lt);
    const j = 1 - i, f = 1000 / phones[j].fps, frameT = Math.ceil(lt / f) * f; // first frame catching it, seen cam ms later
    pend.push({ at: frameT + phones[j].cam + 5 + R() * 10, tf: frameT + phones[j].cam, o: os[j] }); } });
  for (let k = pend.length - 1; k >= 0; k--) if (pend[k].at <= t) { pend[k].o.onFlash(pend[k].tf); pend.splice(k, 1); }
}
const off = lights[0].slice(-8, -1).map(x => Math.round(Math.min(...lights[1].map(y => Math.abs(y - x)))));
console.log('final real light-on offsets ms:', off, 'nudges', os.map(o => o.nudges));
