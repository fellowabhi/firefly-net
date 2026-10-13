import { Sim, DEFAULTS } from './sim.js';
const $ = id => document.getElementById(id), cv = $('cv'), ctx = cv.getContext('2d'), ch = $('chart'), cx = ch.getContext('2d');
let cfg = structuredClone(DEFAULTS), sim, running = false, view = { s: 4, x: 0, y: 0 };
const get = (o, p) => p.split('.').reduce((a, k) => a[k], o), set = (o, p, v) => { const k = p.split('.'); k.slice(0, -1).reduce((a, x) => a[x], o)[k.at(-1)] = v; };
const inputs = [...document.querySelectorAll('aside input,aside select')].filter(e => e.id && e.id !== 'colorPlat');
function toForm() { for (const e of inputs) { const v = get(cfg, e.id); if (e.type === 'checkbox') e.checked = v; else e.value = v; upd(e); } }
function fromForm() { for (const e of inputs) { let v = e.type === 'checkbox' ? e.checked : e.value; if (e.id !== 'layout') v = typeof v === 'boolean' ? v : +v; set(cfg, e.id, v); } }
function upd(e) { if (e.nextElementSibling?.tagName === 'OUTPUT') e.nextElementSibling.value = e.value; }
inputs.forEach(e => e.addEventListener('input', () => upd(e)));
function reset() { fromForm(); sim = new Sim(cfg); fit(); running = false; $('play').textContent = '▶ Start'; render(); }
function fit() { const r = cv.getBoundingClientRect(); let a=1e9,b=-1e9,c=1e9,d=-1e9; for (let i=0;i<sim.n;i++){a=Math.min(a,sim.x[i]);b=Math.max(b,sim.x[i]);c=Math.min(c,sim.y[i]);d=Math.max(d,sim.y[i]);}
  view.s = Math.min(r.width / (b - a + 10), r.height / (d - c + 10)) * 0.92; view.x = (a + b) / 2; view.y = (c + d) / 2; }
function resize() { const r = cv.getBoundingClientRect(), dp = devicePixelRatio || 1; cv.width = r.width * dp; cv.height = r.height * dp; ctx.setTransform(dp, 0, 0, dp, 0, 0); }
function render() {
  const r = cv.getBoundingClientRect(), W = r.width, H = r.height, { s } = view; ctx.fillStyle = '#03050a'; ctx.fillRect(0, 0, W, H);
  const tx = x => (x - view.x) * s + W / 2, ty = y => (y - view.y) * s + H / 2;
  if (cfg.layout === 'bowl') { ctx.strokeStyle = '#1d4a2a'; ctx.fillStyle = '#0b2214'; ctx.beginPath(); ctx.ellipse(tx(0), ty(0), 52.5 * s, 34 * s, 0, 0, 7); ctx.fill(); ctx.stroke(); }
  const rad = Math.max(1.2, Math.min(6, s * 0.45)), plat = $('colorPlat').checked, fm = cfg.flashMs;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < sim.n; i++) { const X = tx(sim.x[i]), Y = ty(sim.y[i]); if (X < -20 || Y < -20 || X > W + 20 || Y > H + 20) continue;
    const age = sim.t - sim.lightOn[i], on = age >= 0 && age < fm, glow = on ? 1 : age < fm + 250 ? 1 - (age - fm) / 250 : 0;
    if (glow > 0) { ctx.fillStyle = `rgba(255,236,150,${0.25 * glow})`; ctx.beginPath(); ctx.arc(X, Y, rad * 4, 0, 7); ctx.fill(); }
    ctx.fillStyle = on ? '#fff8d0' : plat ? (sim.ios[i] ? '#5a7dff' : '#3fbf6a') : '#556'; ctx.globalAlpha = on ? 1 : 0.55;
    ctx.fillRect(X - rad / 2, Y - rad / 2, rad, rad); ctx.globalAlpha = 1; }
  ctx.globalCompositeOperation = 'source-over';
  const m = sim.history.at(-1) || sim.metrics(), st = sim.syncTime;
  $('stats').textContent = `t = ${(sim.t / 1000).toFixed(1)} s   phones ${sim.n} (avg sees ${sim.avgNeighbors.toFixed(0)})\n` +
    `order R = ${m.R.toFixed(3)}   synced cluster ${(m.cluster * 100).toFixed(1)}%\n` + `flash timing spread (σ) ${m.flashSpreadMs.toFixed(0)} ms\n` + `time to 90% sync: ${st === null ? '—' : (st / 1000).toFixed(1) + ' s'}\n` +
    `flashes ${sim.flashes}  detections ${sim.detections}  false ${sim.falseDet}`;
  drawChart();
}
function drawChart() { const w = ch.width, h = ch.height, hs = sim.history; cx.fillStyle = '#060912'; cx.fillRect(0, 0, w, h); cx.strokeStyle = '#223'; cx.strokeRect(0, 0, w, h);
  if (!hs.length) return; const tmax = Math.max(10000, hs.at(-1).t);
  for (const [k, c] of [['R', '#ffd75e'], ['cluster', '#5ad1ff']]) { cx.strokeStyle = c; cx.beginPath(); hs.forEach((p, i) => { const X = p.t / tmax * w, Y = h - 4 - p[k] * (h - 8); i ? cx.lineTo(X, Y) : cx.moveTo(X, Y); }); cx.stroke(); }
  cx.fillStyle = '#ffd75e'; cx.fillText('R', 4, 12); cx.fillStyle = '#5ad1ff'; cx.fillText('cluster %', 16, 12); cx.fillStyle = '#889'; cx.fillText((tmax / 1000).toFixed(0) + 's', w - 30, h - 6); }
let last = performance.now();
function loop(now) { const dt = Math.min(100, now - last); last = now; if (running) sim.step(dt * +$('speed').value); render(); requestAnimationFrame(loop); }
// pan / zoom (mouse wheel, drag, two-finger pinch)
const ptrs = new Map(); let pinch = null;
cv.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
function zoomAt(px, py, f) { const r = cv.getBoundingClientRect(), wx = (px - r.width / 2) / view.s + view.x, wy = (py - r.height / 2) / view.s + view.y;
  view.s = Math.max(0.2, Math.min(200, view.s * f)); view.x = wx - (px - r.width / 2) / view.s; view.y = wy - (py - r.height / 2) / view.s; }
cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); });
cv.addEventListener('pointermove', e => { const p = ptrs.get(e.pointerId); if (!p) return;
  if (ptrs.size === 1) { view.x -= (e.offsetX - p.x) / view.s; view.y -= (e.offsetY - p.y) / view.s; }
  else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d0 = Math.hypot(a.x - b.x, a.y - b.y); p.x = e.offsetX; p.y = e.offsetY; const [c, d] = [...ptrs.values()], d1 = Math.hypot(c.x - d.x, c.y - d.y);
    if (d0 > 0) zoomAt((c.x + d.x) / 2, (c.y + d.y) / 2, d1 / d0); return; }
  p.x = e.offsetX; p.y = e.offsetY; });
['pointerup', 'pointercancel'].forEach(t => cv.addEventListener(t, e => ptrs.delete(e.pointerId)));
$('play').onclick = () => { running = !running; $('play').textContent = running ? '⏸ Pause' : '▶ Start'; };
$('reset').onclick = reset; $('apply').onclick = () => { reset(); $('cfg').classList.remove('open'); };
$('defaults').onclick = () => { cfg = structuredClone(DEFAULTS); toForm(); reset(); };
$('fit').onclick = fit; $('toggleCfg').onclick = () => $('cfg').classList.toggle('open');
addEventListener('resize', resize);
const q = new URLSearchParams(location.search); toForm(); resize(); reset();
if (q.has('autoplay')) { running = true; $('play').textContent = '⏸ Pause'; if (q.has('speed')) $('speed').value = q.get('speed'); }
window.lumisync = { get sim() { return sim; } };
requestAnimationFrame(loop);
