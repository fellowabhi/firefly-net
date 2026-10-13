import { Sim } from './src/sim.js';
const over = JSON.parse(process.argv[2] || '{}'); const s = new Sim(over); const T = (over.secs||300)*1000;
console.log('avgNeighbors', s.avgNeighbors.toFixed(1));
for (let t = 0; t < T; t += 10000) { s.step(10000); const m = s.metrics(); console.log(`t=${(s.t/1000)|0}s R=${m.R.toFixed(3)} cluster=${(m.cluster*100).toFixed(1)}%`); if (m.cluster>0.97) break; }
console.log('syncTime(90% cluster)', s.syncTime && (s.syncTime/1000).toFixed(1)+'s');
