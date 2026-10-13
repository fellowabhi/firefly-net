// node src/sync.test.mjs : two simulated phones seeing each other converge (light-on offsets)
import { Oscillator, Detector } from './sync.js';
const lag = { a: 120, b: 60 }, pend = [], fires = { a: [], b: [] };
const a = new Oscillator({}, 0), b = new Oscillator({}, 0); a.start = 0; b.start = -300;
a.torchLagMs = lag.a; b.torchLagMs = lag.b; // self-calibrated torch lag
for (let t = 0; t < 30000; t++) {
  for (const [n, o, other] of [['a', a, b], ['b', b, a]]) if (o.tick(t)) {
    fires[n].push(t + lag[n]); pend.push({ at: t + lag[n] + 33 * Math.random() + 40, o: other }); }
  for (let i = pend.length - 1; i >= 0; i--) if (pend[i].at <= t) { pend[i].o.onFlash(t, 56); pend.splice(i, 1); }
}
const off = fires.a.slice(-5).map(x => Math.min(...fires.b.map(y => Math.abs(y - x))));
console.log('final light-on offsets ms:', off, 'nudges', a.nudges, b.nudges);
const d = new Detector(); let s = 0;
for (let t = 150; t < 3150; t += 33) { const l = 80 + Math.random() * 2 + (t % 1000 < 100 ? 40 : 0); if (d.push(l, t).spike) s++; }
console.log('detector spikes in 3s (expect 3):', s);
