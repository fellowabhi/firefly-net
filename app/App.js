// Firefly Net v0.2 prototype. Pulse-coupled torch sync with startup lag calibration, debug screen, log sharing.
// All event times are "perceived" times (camera frame timestamps mapped to the JS clock), see src/sync.js.
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable, StatusBar, ScrollView, useWindowDimensions } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { scheduleOnRN } from 'react-native-worklets';
import { Camera, useCameraPermission, useFrameOutput, CommonResolutions } from 'react-native-vision-camera';
import { Oscillator, Detector, DEFAULTS, correlateLag, makePattern, median, mad } from './src/sync';

const VERSION = '0.2';
const now = () => performance.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TL_MS = 4000;          // timeline window
const CAL_RUNS = 4, SLOT = 100, MIN_R = 0.6;

export default function App() {
  useKeepAwake();
  const { width } = useWindowDimensions();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [running, setRunning] = useState(false);
  const [coupling, setCoupling] = useState(DEFAULTS.coupling);
  const [aeLock, setAeLock] = useState(true);
  const [flashOn, setFlashOn] = useState(false);
  const [torchProp, setTorchProp] = useState('off');
  const [ui, setUi] = useState(null);
  const camRef = useRef(null);
  const S = useRef(null);
  if (!S.current) S.current = { mode: 'idle', det: new Detector(), osc: null, frames: [], tsOff: null, camDelays: [], log: [], events: [], offs: [],
    echoSamples: [], cmds: 0, echoes: 0, ext: 0, calib: [], calSamples: null, lagSrc: '-', warn: '', luma: 0, thr: 0, base: 0, echoForCmd: true };

  useEffect(() => { if (!hasPermission) requestPermission(); }, [hasPermission]);
  useEffect(() => { if (S.current.osc) S.current.osc.cfg.coupling = coupling; }, [coupling]);

  const log = (type, ...v) => { const s = S.current; if (s.log.length < 400000) s.log.push(`${now().toFixed(1)},${type},${v.map(x => typeof x === 'number' ? +x.toFixed(2) : x).join(',')}`); };
  const ev = (type, t, t2) => { const s = S.current; s.events.push({ type, t, t2 }); if (s.events.length > 200) s.events.shift(); };

  const setTorch = useCallback((on) => {
    const s = S.current; setFlashOn(on); const ctl = camRef.current?.controller;
    if (ctl) { const t0 = now(); ctl.setTorchMode(on ? 'on' : 'off').then(() => log('torch_ack', on ? 1 : 0, now() - t0)).catch(() => setTorchProp(on ? 'on' : 'off')); }
    else setTorchProp(on ? 'on' : 'off');
  }, []);

  // ---------- per-frame (JS thread) ----------
  const onFrame = useCallback((luma, tsRaw) => {
    const s = S.current, recv = now();
    // map camera timestamp (ns on Android) to JS clock: offset = min(recv - ts) over recent frames
    let ts = tsRaw > 1e11 ? tsRaw / 1e6 : tsRaw > 0 ? tsRaw : recv;
    const d = recv - ts;
    if (s.tsOff == null || d < s.tsOff || d - s.tsOff > 2000) s.tsOff = d; else s.tsOff += 0.002; // slow upward leak
    const tf = ts + s.tsOff;
    s.camDelays.push(recv - tf); if (s.camDelays.length > 60) s.camDelays.shift();
    s.frames.push(tf); if (s.frames.length > 31) s.frames.shift();
    const fi = s.frames.length > 1 ? (s.frames[s.frames.length - 1] - s.frames[0]) / (s.frames.length - 1) : 33;
    s.fi = fi;
    const r = s.det.push(luma, tf); s.luma = luma; s.thr = r.threshold; s.base = s.det.base;
    log('frame', tf, luma, s.det.base, r.threshold, recv - tf);
    if (s.calSamples) s.calSamples.push({ t: tf, l: luma });
    if (s.mode !== 'run' || !r.spike) return;
    const o = s.osc, e = o.expectedEcho(), jit = s.echoSamples.length >= 5 ? mad(s.echoSamples) : 20;
    const m = Math.max(1.5 * fi, 3 * jit, 40);
    if (!s.echoForCmd && Math.abs(tf - e) <= m) { // our own torch reflection
      s.echoForCmd = true; s.echoes++; const sample = tf - o.lastCmd;
      s.echoSamples.push(sample); if (s.echoSamples.length > 15) s.echoSamples.shift();
      if (s.echoSamples.length >= 5) { o.lagMs = median(s.echoSamples); s.lagSrc = 'live echo'; }
      ev('echo', tf); log('echo', tf, sample, o.lagMs);
    } else {
      const off = o.offsetOf(tf), shift = o.onFlash(tf); s.ext++;
      s.offs.push({ t: tf, off }); if (s.offs.length > 60) s.offs.shift();
      ev('ext', tf); log('ext', tf, off, shift, o.adj);
    }
  }, []);

  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.VGA_4_3, pixelFormat: 'yuv', dropFramesWhileBusy: true,
    onFrame: useCallback((frame) => {
      'worklet';
      try {
        let buf, w = frame.width, h = frame.height, row = frame.bytesPerRow;
        if (frame.isPlanar) { const p = frame.getPlanes()[0]; buf = p.getPixelBuffer(); w = p.width; h = p.height; row = p.bytesPerRow; }
        else buf = frame.getPixelBuffer();
        const px = new Uint8Array(buf); let sum = 0, n = 0;
        const y0 = Math.floor(h * 0.2), y1 = Math.floor(h * 0.8), x0 = Math.floor(w * 0.2), x1 = Math.floor(w * 0.8);
        for (let y = y0; y < y1; y += 8) { const o = y * row; for (let x = x0; x < x1; x += 8) { sum += px[o + x]; n++; } }
        scheduleOnRN(onFrame, n ? sum / n : 0, frame.timestamp);
      } finally { frame.dispose(); }
    }, [onFrame]),
  });

  // ---------- calibration + run loop ----------
  useEffect(() => {
    if (!running) return;
    const s = S.current; let alive = true, iv = null, offT = null;
    Object.assign(s, { mode: 'warm', det: new Detector(), offs: [], events: [], echoSamples: [], calib: [], cmds: 0, echoes: 0, ext: 0, warn: '', lagSrc: '-', log: [] });
    s.log.push(`# Firefly Net v${VERSION} log, started ${new Date().toISOString()}, perf_now=${now().toFixed(1)}`);
    s.log.push('# t_ms(js clock),type,values... | frame: tf,luma,base,thr,camDelay | cmd: on,lagMs | torch_ack: on,apiMs | echo: tf,sampleMs,lagMs | ext: tf,offsetMs(+ = other later),shiftMs,adjMs | calib: run,lagMs,r | lag: lagMs,source');
    (async () => {
      await sleep(1500); if (!alive) return;
      const ctl = camRef.current?.controller;
      if (aeLock && ctl) { try { await ctl.lockCurrentExposure(); log('info', 'exposure_locked'); } catch (e) { log('info', 'exposure_lock_failed'); } }
      s.mode = 'calib';
      for (let k = 0; k < CAL_RUNS && alive; k++) {
        const bits = makePattern(), cmds = []; s.calSamples = []; const t0 = now();
        for (let i = 0; i < bits.length; i++) { const target = t0 + i * SLOT; await sleep(Math.max(0, target - now()));
          if (i === 0 || bits[i] !== bits[i - 1]) { cmds.push({ t: now(), on: bits[i] }); setTorch(!!bits[i]); log('cmd', bits[i], -1); } }
        await sleep(Math.max(0, t0 + bits.length * SLOT - now())); cmds.push({ t: now(), on: 0 }); setTorch(false);
        await sleep(800);
        const res = correlateLag(s.calSamples.filter(x => x.t > t0 - 100), cmds); s.calSamples = null;
        s.calib.push(res); log('calib', k, res.lag, res.r);
        await sleep(300);
      }
      if (!alive) return;
      const good = s.calib.filter(c => c.r >= MIN_R).map(c => c.lag);
      const osc = new Oscillator({ coupling }, now());
      if (good.length >= 2) { osc.lagMs = median(good); s.lagSrc = `calibration (${good.length}/${CAL_RUNS} ok)`; s.calJitter = good.length > 1 ? mad(good) : 0; }
      else { s.warn = 'Own flash not visible. Point the camera at a wall or ceiling (~0.5-1 m) and restart.'; s.lagSrc = `default (calibration failed)`; }
      log('lag', osc.lagMs, s.lagSrc);
      s.osc = osc; s.det = new Detector(); s.echoForCmd = true; s.mode = 'run';
      iv = setInterval(() => {
        const t = now();
        if (osc.tick(t)) {
          if (!s.echoForCmd) log('echo_missed', osc.lastCmd);
          s.cmds++; s.echoForCmd = false; setTorch(true); log('cmd', 1, osc.lagMs); ev('cmd', t, osc.expectedEcho());
          clearTimeout(offT); offT = setTimeout(() => { setTorch(false); log('cmd', 0, osc.lagMs); }, DEFAULTS.flashMs);
        }
      }, 3);
    })();
    const uiT = setInterval(() => {
      const t = now(), o = s.osc;
      const fps = s.fi ? 1000 / s.fi : 0, rec = s.offs.filter(x => t - x.t < 4000).slice(-5).map(x => x.off), med = median(rec);
      const lockBand = Math.max(35, 1.2 * (s.fi || 33));
      let state = 'No other phone seen yet';
      if (s.mode === 'warm') state = 'Warming up camera...'; else if (s.mode === 'calib') state = `Calibrating ${s.calib.length + 1}/${CAL_RUNS}: keep still`;
      else if (rec.length) state = Math.abs(med) <= lockBand ? `LOCKED (within ${Math.abs(med).toFixed(0)} ms)` : med > 0 ? `AHEAD by ${med.toFixed(0)} ms (other phone flashes later)` : `BEHIND by ${(-med).toFixed(0)} ms (other phone flashes earlier)`;
      const echoRate = s.cmds > 3 ? s.echoes / s.cmds : null;
      let warn = s.warn; if (s.mode === 'run' && echoRate != null && echoRate < 0.3 && !warn) warn = 'Own flash rarely visible: point camera at a wall/ceiling so lag stays calibrated.';
      setUi({ t, fps, state, warn, mode: s.mode, lag: o?.lagMs, lagSrc: s.lagSrc, jitter: s.echoSamples.length >= 5 ? mad(s.echoSamples) : s.calJitter,
        cam: median(s.camDelays), echoRate, cmds: s.cmds, ext: s.ext, adj: o?.adj ?? 0, phase: o ? o.phase(t) : 0, luma: s.luma, thr: s.thr, base: s.base,
        calib: s.calib.slice(), events: s.events.filter(e => t - e.t < TL_MS + 500), offs: s.offs.slice(-40) });
    }, 120);
    return () => { alive = false; clearInterval(iv); clearInterval(uiT); clearTimeout(offT); s.mode = 'idle'; s.calSamples = null; setTorch(false); };
  }, [running]);

  const shareLog = async () => {
    try {
      const f = new File(Paths.cache, `firefly-net-log-${Date.now()}.csv`); f.create({ overwrite: true }); f.write(S.current.log.join('\n'));
      await Sharing.shareAsync(f.uri, { mimeType: 'text/csv', dialogTitle: 'Share Firefly Net log' });
    } catch (e) { S.current.warn = 'Share failed: ' + e.message; }
  };

  if (!hasPermission) return <View style={st.c}><Text style={st.t}>Camera permission needed</Text><Btn label="Grant" onPress={requestPermission} /></View>;
  const W = width - 24;
  return (
    <View style={[st.c, flashOn && running && { backgroundColor: '#fff' }]}>
      <StatusBar hidden />
      <Camera ref={camRef} style={st.cam} device="back" isActive={running} outputs={[frameOutput]} torchMode={torchProp} />
      <ScrollView style={{ width: '100%' }} contentContainerStyle={{ padding: 12, paddingTop: 30 }}>
        <Text style={st.title}>Firefly Net v{VERSION}</Text>
        {ui && <>
          <Text style={[st.state, ui.state.startsWith('LOCKED') && { color: '#7CFC8A' }]}>{ui.state}</Text>
          {!!ui.warn && <Text style={st.warn}>⚠ {ui.warn}</Text>}
          <Panel title="Timeline (last 4 s, newest on the right)">
            <Timeline ui={ui} W={W - 20} />
            <Text style={st.leg}><Text style={{ color: '#ff9f1c' }}>■ My torch command</Text>   <Text style={{ color: '#ffe08a' }}>□ when my light should appear (command + lag)</Text>{'\n'}<Text style={{ color: '#999' }}>| my own flash seen by camera</Text>   <Text style={{ color: '#ffd23f' }}>| other phone's flash seen</Text></Text>
          </Panel>
          <Panel title="Offset to other phone (ms) over time">
            <OffsetChart offs={ui.offs} W={W - 20} band={Math.max(35, 1.2 * (1000 / (ui.fps || 30)))} />
            <Text style={st.leg}>Each dot = one detected flash. Above 0: other phone is LATER than me. Below 0: EARLIER. Green band = locked. Goal: dots settle in the band.</Text>
          </Panel>
          <Panel title="Delays">
            <Row k="Torch lag (command → my light seen)" v={ui.lag != null ? `${ui.lag.toFixed(0)} ms` : '-'} />
            <Row k="  source" v={ui.lagSrc} />
            <Row k="  jitter (±, median abs dev)" v={ui.jitter != null ? `${ui.jitter.toFixed(0)} ms` : '-'} />
            <Row k="Camera → app delay" v={isFinite(ui.cam) ? `${ui.cam.toFixed(0)} ms` : '-'} />
            <Row k="Camera fps" v={ui.fps.toFixed(1)} />
            <Row k="Own flash seen" v={ui.echoRate != null ? `${(ui.echoRate * 100).toFixed(0)}% of flashes` : '-'} />
            <Row k="Calibration runs (lag / match)" v={ui.calib.map(c => `${c.lag}ms/${c.r.toFixed(2)}`).join('  ') || '-'} />
          </Panel>
          <Panel title="Counters">
            <Row k="My flashes / other flashes seen" v={`${ui.cmds} / ${ui.ext}`} />
            <Row k="Pending correction to next flash" v={`${ui.adj.toFixed(0)} ms`} />
            <Row k="Brightness now / baseline / trigger" v={`${ui.luma.toFixed(0)} / ${(ui.base ?? 0).toFixed(0)} / +${ui.thr.toFixed(0)}`} />
          </Panel>
        </>}
        <View style={st.row}><Btn big label={running ? 'Stop' : 'Start'} onPress={() => setRunning(r => !r)} /></View>
        <View style={st.row}>
          <Btn label="Share log" onPress={shareLog} />
          <Btn label={`Lock exposure: ${aeLock ? 'on' : 'off'}`} onPress={() => setAeLock(a => !a)} />
        </View>
        <View style={st.row}>
          <Btn label="−" onPress={() => setCoupling(c => Math.max(0.05, +(c - 0.05).toFixed(2)))} />
          <Text style={st.t}>correction strength {coupling.toFixed(2)}</Text>
          <Btn label="+" onPress={() => setCoupling(c => Math.min(1, +(c + 0.05).toFixed(2)))} />
        </View>
        <Text style={st.leg}>Tip: Start both phones, point each camera at a wall/ceiling during the first ~8 s (calibration), then face the phones toward each other. Exposure lock applies on next Start.</Text>
      </ScrollView>
    </View>
  );
}

function Timeline({ ui, W }) {
  const x = (t) => W * (1 - (ui.t - t) / TL_MS);
  const ev = ui.events.filter(e => x(e.t) > -20);
  return (
    <View style={{ width: W, height: 70, backgroundColor: '#0b1020', overflow: 'hidden' }}>
      <Text style={[st.tl, { top: 2 }]}>me</Text><Text style={[st.tl, { top: 42 }]}>camera</Text>
      {ev.filter(e => e.type === 'cmd').map((e, i) => <View key={'c' + i}>
        <View style={{ position: 'absolute', left: x(e.t), top: 4, width: Math.max(2, W * DEFAULTS.flashMs / TL_MS), height: 14, backgroundColor: '#ff9f1c' }} />
        <View style={{ position: 'absolute', left: x(e.t2), top: 20, width: Math.max(2, W * DEFAULTS.flashMs / TL_MS), height: 14, borderColor: '#ffe08a', borderWidth: 1 }} />
      </View>)}
      {ev.filter(e => e.type !== 'cmd').map((e, i) => <View key={'d' + i} style={{ position: 'absolute', left: x(e.t), top: 38, width: 3, height: 30, backgroundColor: e.type === 'ext' ? '#ffd23f' : '#888' }} />)}
    </View>
  );
}

function OffsetChart({ offs, W, band }) {
  const H = 110, R = 500, y = (o) => H / 2 - (H / 2) * Math.max(-1, Math.min(1, o / R));
  return (
    <View style={{ width: W, height: H, backgroundColor: '#0b1020' }}>
      <View style={{ position: 'absolute', left: 0, right: 0, top: y(band), height: y(-band) - y(band), backgroundColor: '#1f4d2a' }} />
      <View style={{ position: 'absolute', left: 0, right: 0, top: H / 2, height: 1, backgroundColor: '#456' }} />
      <Text style={[st.tl, { top: 0 }]}>+500 later</Text><Text style={[st.tl, { bottom: 0 }]}>-500 earlier</Text>
      {offs.map((o, i) => <View key={i} style={{ position: 'absolute', left: (W - 8) * (i + 1) / Math.max(offs.length, 1) - 3, top: y(o.off) - 3, width: 6, height: 6, borderRadius: 3, backgroundColor: '#ffd23f' }} />)}
      {offs.length > 0 && <Text style={[st.tl, { right: 4, left: undefined, top: 0, color: '#ffd23f' }]}>{offs[offs.length - 1].off.toFixed(0)} ms</Text>}
    </View>
  );
}

const Panel = ({ title, children }) => <View style={st.box}><Text style={st.ph}>{title}</Text>{children}</View>;
const Row = ({ k, v }) => <View style={st.kv}><Text style={st.k}>{k}</Text><Text style={st.v}>{v}</Text></View>;
const Btn = ({ label, onPress, big }) => <Pressable onPress={onPress} style={[st.btn, big && st.big]}><Text style={[st.bt, big && { fontSize: 22 }]}>{label}</Text></Pressable>;

const st = StyleSheet.create({
  c: { flex: 1, backgroundColor: '#05070d' },
  cam: { width: 90, height: 120, position: 'absolute', top: 30, right: 12, borderRadius: 8, overflow: 'hidden', zIndex: 2 },
  title: { color: '#ffd23f', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  state: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 6, marginRight: 100 },
  warn: { color: '#ff8a80', fontSize: 14, marginBottom: 6, fontWeight: '600' },
  box: { backgroundColor: '#000c', padding: 10, borderRadius: 10, marginBottom: 10 },
  ph: { color: '#9cf', fontWeight: '700', marginBottom: 6 },
  leg: { color: '#9ab', fontSize: 11, marginTop: 6 },
  tl: { position: 'absolute', left: 4, color: '#678', fontSize: 9, zIndex: 1 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  k: { color: '#9ab', fontSize: 12, flex: 1 }, v: { color: '#fff', fontSize: 12, fontFamily: 'monospace' },
  t: { color: '#fff', fontSize: 14, marginHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' },
  btn: { backgroundColor: '#1d2a44', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, margin: 4 },
  big: { backgroundColor: '#ffb300', paddingHorizontal: 50, paddingVertical: 16 },
  bt: { color: '#fff', fontWeight: '600' },
});
