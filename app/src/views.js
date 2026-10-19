// Normal + Debug views (react-native-svg), driven by engine.snapshot().
import { memo, useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Circle, Path, Line, Rect, G, Defs, RadialGradient, Stop, Text as SText, Polyline } from 'react-native-svg';
import { C, MONO, Icon, clamp, lockColor, rgb, lockFrac, arcPath } from './ui';
import { wrapMs } from './sync';
const P = 1000, LOCK_MS = 20;
const glow = (now, t) => Math.exp(-Math.max(0, now - t) / 170);

export function statusOf(s) {
  if (!s) return { title: 'Starting…', icon: 'sync', color: C.dim };
  if (s.mode === 'calib') return { title: 'Calibrating torch…', icon: 'sync', color: C.amber };
  if (!s.peers.length) return { title: s.channel === 'ble' ? 'Searching for phones…' : 'Listening for chirps…', icon: 'sync', color: C.dim };
  if (s.locked) return { title: `Locked ±${Math.max(1, Math.round(s.err))} ms`, icon: 'lock', color: C.ff };
  return { title: `Syncing… ${s.peers.length} ${s.peers.length === 1 ? 'phone' : 'phones'} nearby`, icon: 'sync', color: rgb(lockColor(s.err)) };
}

// ---------- shared small pieces ----------
export function Seg({ options, value, onChange, small, style }) {
  return <View style={[st.seg, small && { padding: 2 }, style]}>
    {options.map(o => { const on = o.v === value; return <Pressable key={o.v} onPress={() => onChange(o.v)} style={[st.segB, small && st.segBs, on && st.segOn, style && { flex: 1 }]}>
      {o.icon && <Icon name={o.icon} size={small ? 13 : 15} color={on ? C.ff : C.dim} />}<Text style={[st.segT, small && { fontSize: 11 }, on && { color: C.ff }]}>{o.label}</Text></Pressable>; })}
  </View>;
}
const Card = ({ title, right, children, style }) => <View style={[st.card, style]}>{title && <View style={st.ct}><Text style={st.ctT}>{title}</Text>{right}</View>}{children}</View>;
const XBtn = ({ icon, label, onPress }) => <Pressable onPress={onPress} style={st.xbtn}><Icon name={icon} size={12} color={C.ff} /><Text style={st.xbtnT}>{label}</Text></Pressable>;

// ---------- NORMAL ----------
const Ticks = memo(function Ticks({ cx, cy, rr }) {
  return <G>{Array.from({ length: 60 }, (_, k) => { const a = k / 60 * 2 * Math.PI - Math.PI / 2, L = k % 5 ? 4 : 9;
    return <Line key={k} x1={cx + Math.cos(a) * (rr + 10)} y1={cy + Math.sin(a) * (rr + 10)} x2={cx + Math.cos(a) * (rr + 10 + L)} y2={cy + Math.sin(a) * (rr + 10 + L)} stroke="#fff" strokeOpacity={k % 5 ? 0.07 : 0.16} strokeWidth={1.2} />; })}</G>;
});
export function BigRing({ s, size }) {
  const cx = size / 2, cy = size / 2, R = size / 2, rr = R * 0.8, now = s?.now ?? 0, g = s ? glow(now, s.lastLight) : 0;
  const col = lockColor(s?.err), lf = lockFrac(s?.err), cr = R * 0.42 * (1 + 0.07 * g);
  return <Svg width={size} height={size}>
    <Defs>
      <RadialGradient id="halo" cx="50%" cy="50%" r="50%"><Stop offset="0.15" stopColor={C.ff} stopOpacity={0.10 + 0.45 * g} /><Stop offset="0.6" stopColor={C.ff} stopOpacity={0.03 + 0.12 * g} /><Stop offset="1" stopColor={C.ff} stopOpacity={0} /></RadialGradient>
      <RadialGradient id="core" cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor="#faffe1" stopOpacity={0.25 + 0.75 * g} /><Stop offset="0.35" stopColor="#d7ff6e" stopOpacity={0.18 + 0.7 * g} /><Stop offset="1" stopColor="#a0e632" stopOpacity={0.02 + 0.1 * g} /></RadialGradient>
      <RadialGradient id="coreGlow" cx="50%" cy="50%" r="50%"><Stop offset="0.6" stopColor={C.ff} stopOpacity={0.35 * g} /><Stop offset="1" stopColor={C.ff} stopOpacity={0} /></RadialGradient>
    </Defs>
    <Circle cx={cx} cy={cy} r={R * 0.98} fill="url(#halo)" />
    <Ticks cx={cx} cy={cy} rr={rr} />
    <Circle cx={cx} cy={cy} r={rr} stroke="#fff" strokeOpacity={0.06} strokeWidth={7} fill="none" />
    <Path d={arcPath(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, Math.min(0.9999, lf)) * 2 * Math.PI)} stroke={rgb(col, 0.25)} strokeWidth={15} fill="none" strokeLinecap="round" />
    <Path d={arcPath(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, Math.min(0.9999, lf)) * 2 * Math.PI)} stroke={rgb(col)} strokeWidth={7} fill="none" strokeLinecap="round" />
    {(s?.peers || []).map(p => { const d = wrapMs(p.off, P), a = d / P * 2 * Math.PI - Math.PI / 2, pg = glow(now, p.lastLight), px = cx + Math.cos(a) * (rr + 30), py = cy + Math.sin(a) * (rr + 30);
      return <G key={p.id}><Circle cx={px} cy={py} r={9 + 6 * pg} fill={C.ff} fillOpacity={0.08 + 0.2 * pg} /><Circle cx={px} cy={py} r={3.5 + 2 * pg} fill={C.ff} fillOpacity={0.35 + 0.65 * pg} /></G>; })}
    <Circle cx={cx} cy={cy} r={cr * 1.6} fill="url(#coreGlow)" />
    <Circle cx={cx} cy={cy} r={cr} fill="url(#core)" />
    <SText x={cx} y={cy + R * 0.04} fill={g > 0.4 ? 'rgba(20,30,8,0.85)' : 'rgba(230,240,220,0.85)'} fontSize={Math.round(R * 0.13)} fontWeight="600" fontFamily={MONO} textAnchor="middle">{s && isFinite(s.err) ? Math.round(lf * 100) + '%' : '—'}</SText>
    <SText x={cx} y={cy + R * 0.14} fill={g > 0.4 ? 'rgba(20,30,8,0.6)' : 'rgba(200,210,200,0.45)'} fontSize={Math.round(R * 0.05)} fontWeight="600" fontFamily={MONO} textAnchor="middle">LOCK</SText>
  </Svg>;
}
export function NormalView({ s, width, onRestart, onDebug }) {
  const stt = statusOf(s), size = Math.min(width - 40, 370);
  const chip = (icon, text) => <View style={st.chip}><Icon name={icon} size={13} color="#9aa6b2" /><Text style={st.chipT}>{text}</Text></View>;
  const pips = [{ name: 'You', lit: s && glow(s.now, s.lastLight) > 0.35, me: true }, ...(s?.peers || []).slice(0, 7).map(p => ({ name: p.name, lit: glow(s.now, p.lastLight) > 0.35 }))];
  return <View style={st.normal}>
    <BigRing s={s} size={size} />
    <View style={{ alignItems: 'center' }}>
      <View style={st.h1}><Icon name={stt.icon} size={22} color={stt.color} sw={2} /><Text style={[st.h1T, { color: stt.color }]} numberOfLines={1}>{stt.title}</Text></View>
      <View style={st.chips}>
        {chip('timer', s && isFinite(s.err) ? `±${Math.round(s.err)} ms` : '—')}{chip('peers', `${s?.peers.length ?? 0} peers`)}
        {chip(s?.channel === 'audio' ? 'audio' : 'ble', s?.channel === 'audio' ? 'Audio' : 'BLE')}{chip(s?.output === 'screen' ? 'screen' : 'torch', s?.output === 'screen' ? 'Screen' : 'Torch')}
      </View>
      {!!s?.warn && <Text style={st.warn}>{s.warn}</Text>}
    </View>
    <View style={st.pips}>{pips.map((p, i) => <View key={i} style={st.pip}><View style={[st.pipB, p.lit && st.pipLit]} /><Text style={[st.pipT, p.me && { color: C.ff }]}>{p.name}</Text></View>)}</View>
    <View style={st.bottom}>
      <Pressable style={st.btn} onPress={onRestart}><Icon name="restart" color={C.txt} /><Text style={st.btnT}>Restart</Text></Pressable>
      <Pressable style={[st.btn, st.btnPri]} onPress={onDebug}><Text style={[st.btnT, { color: C.ff }]}>Debug view</Text><Icon name="arrow" color={C.ff} /></Pressable>
    </View>
  </View>;
}

// ---------- DEBUG ----------
function MiniRing({ s }) {
  const g = s ? glow(s.now, s.lastLight) : 0, col = lockColor(s?.err), lf = lockFrac(s?.err), w = 46, c = w / 2;
  return <Svg width={w} height={w}><Defs><RadialGradient id="mg" cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor="#faffdc" stopOpacity={0.2 + 0.8 * g} /><Stop offset="1" stopColor={C.ff} stopOpacity={0.04 + 0.2 * g} /></RadialGradient></Defs>
    <Circle cx={c} cy={c} r={c - 3} stroke="#fff" strokeOpacity={0.07} strokeWidth={3} fill="none" />
    <Path d={arcPath(c, c, c - 3, -Math.PI / 2, -Math.PI / 2 + Math.max(0.03, Math.min(0.9999, lf)) * 2 * Math.PI)} stroke={rgb(col)} strokeWidth={3} strokeLinecap="round" fill="none" />
    <Circle cx={c} cy={c} r={w * 0.3 * (1 + 0.08 * g)} fill="url(#mg)" /></Svg>;
}
function hashAngle(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return (h % 628) / 100; }
function Radar({ s, size }) {
  const pos = useRef({}).current, cx = size / 2, cy = size / 2, R = size / 2 - 6, now = s?.now ?? 0;
  const sa = (now / 1600) % (2 * Math.PI);
  const blip = (key, px, py, col, lastLight) => { const g = glow(now, lastLight), e = Math.exp(-Math.max(0, now - lastLight) / 520);
    return <G key={key}><Circle cx={px} cy={py} r={7 + (1 - e) * 10} stroke={col} strokeOpacity={0.6 * e} fill="none" /><Circle cx={px} cy={py} r={7} stroke={col} strokeOpacity={0.35 + 0.3 * g} fill="none" />
      <Circle cx={px} cy={py} r={4 + 1.5 * g} fill={col} fillOpacity={0.8 + 0.2 * g} /></G>; };
  return <Svg width={size} height={size}>
    {[0.33, 0.66, 1].map(f => <Circle key={f} cx={cx} cy={cy} r={R * f} stroke={C.ff} strokeOpacity={0.07} fill="none" />)}
    <Line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke={C.ff} strokeOpacity={0.05} /><Line x1={cx} y1={cy - R} x2={cx} y2={cy + R} stroke={C.ff} strokeOpacity={0.05} />
    <Path d={`M${cx} ${cy} L${cx + Math.cos(sa - 0.9) * R} ${cy + Math.sin(sa - 0.9) * R} A${R} ${R} 0 0 1 ${cx + Math.cos(sa) * R} ${cy + Math.sin(sa) * R} Z`} fill={C.ff} fillOpacity={0.07} />
    {['-55', '-75', '-95'].map((t, i) => <SText key={t} x={cx + Math.cos(0.34) * R * [0.33, 0.66, 0.97][i] - (i === 2 ? 6 : 0)} y={cy + Math.sin(0.34) * R * [0.33, 0.66, 0.97][i] + 9} fill="rgba(125,138,150,0.6)" fontSize={8} fontFamily={MONO} textAnchor="middle">{t}</SText>)}
    {(s?.peers || []).map(p => { const target = clamp((-(p.rssi ?? -70) - 35) / 60, 0.3, 0.92) * R; const q = pos[p.id] ?? (pos[p.id] = target); pos[p.id] = q + (target - q) * 0.12;
      const a = hashAngle(p.id), px = cx + Math.cos(a) * pos[p.id], py = cy + Math.sin(a) * pos[p.id], ca = Math.cos(a);
      return <G key={p.id}>{blip('b', px, py, p.color, p.lastLight)}<SText x={px + ca * 12} y={py + Math.sin(a) * 12 + 3} fill="rgba(232,238,242,0.75)" fontSize={8.5} fontWeight="600" fontFamily={MONO} textAnchor={ca > 0.35 ? 'start' : ca < -0.35 ? 'end' : 'middle'}>{p.name}</SText></G>; })}
    {blip('me', cx, cy, C.ff, s?.lastLight ?? -1e9)}
  </Svg>;
}
function Num({ label, value, unit, color, onPress }) {
  return <Pressable onPress={onPress} style={st.num}><Text style={st.numS}>{label}</Text><Text style={[st.numB, color && { color }]} numberOfLines={1}>{value}{unit ? <Text style={st.numU}> {unit}</Text> : null}</Text></Pressable>;
}
function Offsets({ s, w }) {
  const sm = useRef({}).current, h = Math.max(60, 14 + 13 + 22 * (1 + (s?.peers.length || 0))), RANGE = 120, L = 34, Rm = 10, top = 14, bot = 13;
  const rows = [{ id: 'me', name: 'You', color: C.ff, dev: s?.selfDev ?? 0 }, ...(s?.peers || []).map(p => ({ id: p.id, name: p.name, color: p.color, dev: p.dev }))];
  const rh = (h - top - bot) / rows.length, X0 = L + (w - L - Rm) / 2, half = (w - L - Rm) / 2, X = v => X0 + clamp(v, -RANGE, RANGE) / RANGE * half;
  return <Svg width={w} height={h}>
    <Rect x={X(-20)} y={top - 2} width={X(20) - X(-20)} height={h - top - bot + 4} fill={C.ff} fillOpacity={0.06} />
    {[-100, -50, 50, 100].map(v => <G key={v}><Line x1={X(v)} y1={top - 2} x2={X(v)} y2={h - bot + 2} stroke="#fff" strokeOpacity={0.04} /><SText x={X(v)} y={h - 2} fill="rgba(125,138,150,0.55)" fontSize={8} fontFamily={MONO} textAnchor="middle">{(v > 0 ? '+' : '−') + Math.abs(v)}</SText></G>)}
    <Line x1={X0} y1={top - 4} x2={X0} y2={h - bot + 2} stroke="rgba(232,238,242,0.28)" /><SText x={X0} y={h - 2} fill="rgba(232,238,242,0.6)" fontSize={8} fontFamily={MONO} textAnchor="middle">0</SText>
    <SText x={L} y={8} fill="rgba(125,138,150,0.75)" fontSize={8} fontWeight="600" fontFamily={MONO}>EARLY</SText><SText x={w - Rm} y={8} fill="rgba(125,138,150,0.75)" fontSize={8} fontWeight="600" fontFamily={MONO} textAnchor="end">LATE</SText>
    <SText x={X0} y={8} fill="rgba(157,255,106,0.55)" fontSize={8} fontWeight="600" fontFamily={MONO} textAnchor="middle">±20 ok</SText>
    {rows.map((r, i) => { const raw = isFinite(r.dev) ? r.dev : 0; sm[r.id] = (sm[r.id] ?? raw) + (raw - (sm[r.id] ?? raw)) * 0.3; const v = sm[r.id];
      const y = top + rh * i + rh / 2, bh = Math.min(8, rh - 5), xe = X(v), x1 = Math.min(X0, xe), bw = Math.max(2, Math.abs(xe - X0)), lbl = (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0) + ' ms';
      let lx = v >= 0 ? xe + 5 : xe - 5, al = v >= 0 ? 'start' : 'end'; if (v >= 0 && lx + 40 > w - Rm) { lx = X0 - 5; al = 'end'; } if (v < 0 && lx - 40 < L) { lx = X0 + 5; al = 'start'; }
      return <G key={r.id}><SText x={2} y={y + 3} fill={r.color} fontSize={9} fontWeight="600" fontFamily={MONO}>{r.name}</SText>
        <Rect x={L} y={y - bh / 2} width={w - L - Rm} height={bh} rx={bh / 2} fill="#fff" fillOpacity={0.035} />
        <Rect x={x1} y={y - bh / 2} width={bw} height={bh} rx={bh / 2} fill={r.color} fillOpacity={0.9} />
        <SText x={lx} y={y + 3} fill="rgba(232,238,242,0.9)" fontSize={9} fontWeight="600" fontFamily={MONO} textAnchor={al}>{lbl}</SText></G>; })}
  </Svg>;
}
function Spark({ s, w }) {
  const h = 26, sp = s?.spread || [], t = s?.now ?? 0, MAX = 200, X = tt => w * (1 - (t - tt) / 30000), Y = v => h - 2 - (clamp(v, 0, MAX) / MAX) * (h - 4);
  const col = lockColor(s?.err), pts = sp.map(d => `${X(d.t).toFixed(1)},${Y(d.v).toFixed(1)}`).join(' '), last = sp[sp.length - 1];
  return <Svg width={w} height={h}><Rect x={0} y={Y(20)} width={w} height={h - 2 - Y(20)} fill={C.ff} fillOpacity={0.07} />
    <Line x1={0} y1={Y(20)} x2={w} y2={Y(20)} stroke={C.ff} strokeOpacity={0.25} strokeDasharray="2,3" />
    {sp.length > 1 && <Polyline points={pts} stroke={rgb(col)} strokeWidth={1.6} fill="none" strokeLinejoin="round" />}
    {last && <Circle cx={Math.min(w - 2.5, X(last.t))} cy={Y(last.v)} r={2.5} fill={rgb(col)} />}</Svg>;
}
function Timeline({ s, w }) {
  const lanes = [{ id: 'me', name: 'You', color: C.ff }, ...(s?.peers || []).slice(0, 6).map(p => ({ id: p.id, name: p.name, color: p.color }))];
  const h = 16 + 4 + 18 * lanes.length, L = 34, Rp = 6, top = 4, bot = 16, lh = (h - top - bot) / lanes.length, span = 5000, t = s?.now ?? 0, X = tt => L + (w - L - Rp) * (1 - (t - tt) / span), y0 = top + lh / 2;
  const inSpan = (tt) => t - tt <= span && tt <= t;
  return <Svg width={w} height={h}>
    {[0, 1, 2, 3, 4, 5].map(k => { const xx = L + (w - L - Rp) * k / 5; return <G key={k}><Line x1={xx} y1={top} x2={xx} y2={h - bot} stroke="#fff" strokeOpacity={0.035} /><SText x={Math.min(xx, w - 12)} y={h - 4} fill="rgba(125,138,150,0.6)" fontSize={8} fontFamily={MONO} textAnchor="middle">{k === 5 ? 'now' : `-${5 - k}s`}</SText></G>; })}
    {lanes.map((ln, i) => { const y = top + lh * i + lh / 2; return <G key={ln.id}>{i === 0 && <Rect x={L} y={top + 1} width={w - L - Rp} height={lh - 2} fill={C.ff} fillOpacity={0.04} />}
      <SText x={4} y={y + 3} fill={ln.color} fontSize={9} fontWeight="600" fontFamily={MONO}>{ln.name}</SText><Line x1={L} y1={y} x2={w - Rp} y2={y} stroke="#fff" strokeOpacity={0.04} /></G>; })}
    {(s?.nudgeHist || []).filter(n => inSpan(n.t)).map((n, i) => { const hh = clamp(Math.abs(n.v) / 60, 0.04, 1) * (lh / 2 - 2); return <Rect key={'n' + i} x={X(n.t) - 0.75} y={n.v < 0 ? y0 : y0 - hh} width={1.5} height={hh} fill={C.amber} fillOpacity={0.75} />; })}
    {(s?.cmdHist || []).filter(inSpan).map((c, i) => <Rect key={'c' + i} x={X(c) - 2.5} y={y0 - lh / 2 + 3} width={5} height={lh - 6} rx={1.2} stroke="rgba(232,238,242,0.75)" strokeWidth={1.2} fill="none" />)}
    {(s?.lightHist || []).filter(inSpan).map((c, i) => <Rect key={'l' + i} x={X(c) - 2} y={y0 - lh / 2 + 3} width={4} height={lh - 6} rx={1} fill={C.ff} />)}
    {(s?.peerHist || []).filter(p => inSpan(p.t)).map((p, i) => { const li = lanes.findIndex(l => l.id === p.id); if (li < 1) return null; const y = top + lh * li + lh / 2;
      return <Rect key={'p' + i} x={X(p.t) - 2} y={y - lh / 2 + 3} width={4} height={lh - 6} rx={1} fill={lanes[li].color} />; })}
  </Svg>;
}
const LegendTL = () => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
  <View style={[st.lgSw, { borderWidth: 1.3, borderColor: C.txt }]} /><Text style={st.lgT}>cmd</Text><View style={[st.lgSw, { backgroundColor: C.ff }]} /><Text style={st.lgT}>light</Text>
  <View style={{ width: 2, height: 10, backgroundColor: C.amber, borderRadius: 1 }} /><Text style={st.lgT}>nudge</Text><Text style={[st.lgT, { color: '#56626e' }]}>5 s</Text></View>;
const LOGC = { rx: C.blue, nd: C.amber, cb: C.ff, sy: C.violet, er: C.red };

export function DebugView({ s, width, channel, output, onChannel, onOutput, onRestart, onExport, onRecal }) {
  const stt = statusOf(s), inner = width - 24 - 18, half = (inner - 8 - 18) / 2 + 9;
  const errC = !s || !isFinite(s.err) ? C.dim : s.err < LOCK_MS ? C.ff : s.err < 80 ? C.amber : C.red;
  return <View style={{ gap: 7, paddingBottom: 16 }}>
    <Card style={{ padding: 10, gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}><MiniRing s={s} />
        <View style={{ flex: 1 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Icon name={stt.icon} size={14} color={stt.color} /><Text style={[st.heroT, { color: stt.color }]} numberOfLines={1}>{s?.locked ? stt.title : s?.peers.length ? `Syncing · ${s.peers.length} peers` : stt.title}</Text></View>
          <Text style={st.sub}>t {(s?.t ?? 0).toFixed(1)}s   R {(s?.R ?? 0).toFixed(3)}</Text></View></View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Seg small style={{ flex: 1 }} value={channel} onChange={onChannel} options={[{ v: 'ble', label: 'BLE', icon: 'ble' }, { v: 'audio', label: 'Audio β', icon: 'audio' }]} />
        <Seg small style={{ flex: 1 }} value={output} onChange={onOutput} options={[{ v: 'torch', label: 'Torch', icon: 'torch' }, { v: 'screen', label: 'Screen', icon: 'screen' }]} />
      </View>
      {!!s?.warn && <Text style={st.warn}>{s.warn}</Text>}
    </Card>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Card title="RADAR" right={<Text style={st.ctEm}>RSSI</Text>} style={{ flex: 1, alignItems: 'center' }}><Radar s={s} size={Math.min(150, half - 18)} /></Card>
      <Card title="NUMBERS" right={<XBtn icon="restart" label="restart" onPress={onRestart} />} style={{ flex: 1 }}>
        <View style={st.nums}>
          <Num label="SYNC ERR" value={s && isFinite(s.err) ? Math.round(s.err) : '—'} unit="ms" color={errC} />
          <Num label="NUDGE" value={`${(s?.lastNudge ?? 0) >= 0 ? '+' : '−'}${Math.abs(s?.lastNudge ?? 0).toFixed(Math.abs(s?.lastNudge ?? 0) < 10 ? 1 : 0)}`} unit="ms" />
          <Num label="PACKETS/S" value={s?.pps ?? 0} unit="/s" />
          <Num label="AVG RSSI" value={s?.avgRssi != null ? Math.round(s.avgRssi) : '—'} unit={s?.avgRssi != null ? 'dBm' : ''} />
          <Num label={s?.output === 'screen' ? 'SCREEN LAG' : 'TORCH LAG ⟳'} value={Math.round(s?.lag ?? 0)} unit="ms" onPress={onRecal} />
          <Num label="CHANNEL" value={s?.channel === 'audio' ? 'Audio' : 'BLE'} color={s?.channel === 'audio' ? C.violet : C.blue} />
        </View>
      </Card>
    </View>
    <Card title="OFFSET VS GROUP" right={<Text style={st.ctEm}>R {(s?.R ?? 0).toFixed(2)}</Text>}>
      <Offsets s={s} w={inner} />
      <View style={st.sprow}><Text style={st.spl}>SPREAD · 30 S</Text><View style={{ flex: 1 }}><Spark s={s} w={inner - 150} /></View><Text style={[st.spv, { color: errC }]}>{s && isFinite(s.err) ? `±${Math.round(s.err)} ms` : '—'}</Text></View>
    </Card>
    <Card title="TIMELINE" right={<LegendTL />}><Timeline s={s} w={inner} /></Card>
    <Card title="DELAYS">
      <Text style={st.kv}>flash lag {Math.round(s?.lag ?? 0)} ms · {s?.lagSrc}{s?.jitter != null ? ` · jitter ±${s.jitter.toFixed(0)} ms` : ''}</Text>
      {s?.channel === 'audio' && <Text style={st.kv}>audio loop (own chirp heard) {s?.loop != null ? `${s.loop.toFixed(0)} ms` : 'measuring…'}</Text>}
      {!!s?.calib?.length && <Text style={st.kv}>calibration runs: {s.calib.map(c => `${c.lag}ms/${c.r.toFixed(2)}`).join('  ')}</Text>}
    </Card>
    <Card title="EVENT LOG" right={<XBtn icon="download" label="Export CSV" onPress={onExport} />}>
      {(s?.ui || []).slice(-14).map((r, i) => <Text key={i} style={st.logL} numberOfLines={1}><Text style={{ color: '#46525e' }}>{r.ts} </Text><Text style={{ color: LOGC[r.cls] || '#9aa6b2' }}>{r.msg}</Text></Text>)}
    </Card>
  </View>;
}

export const st = StyleSheet.create({
  seg: { flexDirection: 'row', backgroundColor: C.tile, borderRadius: 999, padding: 3, gap: 2 },
  segB: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  segBs: { paddingVertical: 4, paddingHorizontal: 8 }, segOn: { backgroundColor: C.acc }, segT: { color: C.dim, fontSize: 12, fontWeight: '600' },
  card: { backgroundColor: C.panel2, borderRadius: 16, padding: 9 }, ct: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  ctT: { color: C.dim, fontFamily: MONO, fontSize: 10, fontWeight: '600', letterSpacing: 1.2 }, ctEm: { color: C.faint, fontFamily: MONO, fontSize: 10 },
  xbtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.acc, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8 }, xbtnT: { color: C.ff, fontFamily: MONO, fontSize: 10, fontWeight: '600' },
  normal: { flex: 1, alignItems: 'center', justifyContent: 'space-evenly', paddingHorizontal: 20, paddingBottom: 22 },
  h1: { flexDirection: 'row', alignItems: 'center', gap: 9 }, h1T: { fontSize: 24, fontWeight: '700' },
  chips: { flexDirection: 'row', gap: 6, justifyContent: 'center', marginTop: 12, flexWrap: 'wrap' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.panel, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 999 }, chipT: { color: C.dim, fontFamily: MONO, fontSize: 12 },
  pips: { flexDirection: 'row', gap: 18, paddingVertical: 12, paddingHorizontal: 22, borderRadius: 999, backgroundColor: C.panel },
  pip: { alignItems: 'center', gap: 6 }, pipB: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.tile2 }, pipLit: { backgroundColor: C.ff, shadowColor: C.ff, shadowOpacity: 1, shadowRadius: 8, elevation: 6 },
  pipT: { color: C.faint, fontFamily: MONO, fontSize: 10, fontWeight: '600' },
  bottom: { flexDirection: 'row', gap: 10, width: '100%' },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 15, borderRadius: 16, backgroundColor: C.tile }, btnPri: { backgroundColor: C.acc },
  btnT: { color: C.txt, fontWeight: '600', fontSize: 14 },
  heroT: { fontSize: 15, fontWeight: '700' }, sub: { color: C.dim, fontFamily: MONO, fontSize: 11 },
  warn: { color: C.amber, fontSize: 12, marginTop: 6, textAlign: 'center' },
  nums: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  num: { backgroundColor: C.tile, borderRadius: 10, paddingVertical: 4, paddingHorizontal: 8, width: '48%' }, numS: { color: C.faint, fontFamily: MONO, fontSize: 8.5, fontWeight: '600', letterSpacing: 0.8 },
  numB: { color: C.txt, fontFamily: MONO, fontSize: 14, fontWeight: '600' }, numU: { color: C.dim, fontSize: 10, fontWeight: '500' },
  sprow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, backgroundColor: C.tile, borderRadius: 10, paddingVertical: 5, paddingHorizontal: 8 },
  spl: { color: C.faint, fontFamily: MONO, fontSize: 9, fontWeight: '600', letterSpacing: 0.6 }, spv: { fontFamily: MONO, fontSize: 12, fontWeight: '600', minWidth: 54, textAlign: 'right' },
  lgSw: { width: 5, height: 10, borderRadius: 1.2 }, lgT: { color: C.faint, fontFamily: MONO, fontSize: 10 },
  kv: { color: '#9aa6b2', fontFamily: MONO, fontSize: 11, marginBottom: 2 }, logL: { color: '#9aa6b2', fontFamily: MONO, fontSize: 11, lineHeight: 17 },
});
