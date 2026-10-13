// Firefly Net v0.1 prototype: torch blinks on a pulse-coupled oscillator; camera brightness
// spikes from OTHER phones nudge our phase so nearby phones converge (see src/sync.js).
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable, StatusBar } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { scheduleOnRN } from 'react-native-worklets';
import { Camera, useCameraPermission, useFrameOutput, CommonResolutions } from 'react-native-vision-camera';
import { Oscillator, Detector, DEFAULTS } from './src/sync';

const GRAPH_N = 90;
const now = () => performance.now();

export default function App() {
  useKeepAwake();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [running, setRunning] = useState(false);
  const [coupling, setCoupling] = useState(DEFAULTS.coupling);
  const [useCtl, setUseCtl] = useState(true); // torch via controller.setTorchMode (fast) vs torchMode prop
  const [torchProp, setTorchProp] = useState('off');
  const [flashOn, setFlashOn] = useState(false);
  const [ui, setUi] = useState({ fps: 0, luma: 0, base: 0, thr: 0, det: 0, ign: 0, phase: 0, lag: 0, echo: 0, graph: [] });
  const camRef = useRef(null);
  const st = useRef(null);
  if (!st.current) st.current = { osc: new Oscillator({}, now()), det: new Detector(), graph: [], frames: [], dets: 0, ign: 0, torch: false, echo: 0, echoAwait: false, last: {} };

  useEffect(() => { if (!hasPermission) requestPermission(); }, [hasPermission]);
  useEffect(() => { st.current.osc.cfg.coupling = coupling; }, [coupling]);

  const setTorch = useCallback((on) => {
    const s = st.current; s.torch = on; setFlashOn(on);
    const ctl = camRef.current?.controller;
    if (useCtl && ctl) ctl.setTorchMode(on ? 'on' : 'off').catch(() => setTorchProp(on ? 'on' : 'off'));
    else setTorchProp(on ? 'on' : 'off');
  }, [useCtl]);

  // oscillator loop (JS thread, ~5ms resolution)
  useEffect(() => {
    if (!running) return;
    const s = st.current; s.det.reset(); s.osc = new Oscillator({ coupling }, now()); s.dets = 0; s.ign = 0;
    let offT = null;
    const iv = setInterval(() => {
      const t = now();
      if (s.osc.tick(t)) { setTorch(true); s.echoAwait = true; clearTimeout(offT); offT = setTimeout(() => setTorch(false), DEFAULTS.flashMs); }
    }, 4);
    const ui = setInterval(() => {
      const f = s.frames, fps = f.length > 1 ? 1000 * (f.length - 1) / (f[f.length - 1] - f[0]) : 0;
      setUi({ fps, ...s.last, det: s.dets, ign: s.ign, phase: ((s.osc.phase(now()) % 1) + 1) % 1, lag: s.osc.torchLagMs, echo: s.echo, nudges: s.osc.nudges, graph: s.graph.slice() });
    }, 100);
    return () => { clearInterval(iv); clearInterval(ui); clearTimeout(offT); setTorch(false); };
  }, [running]);

  // called on JS thread for every camera frame with mean luma
  const onLuma = useCallback((luma) => {
    const s = st.current, t = now();
    s.frames.push(t); if (s.frames.length > 30) s.frames.shift();
    const fi = s.frames.length > 1 ? (t - s.frames[0]) / (s.frames.length - 1) : 33;
    const camLat = 1.5 * fi + 20; // est. exposure-mid -> JS delivery latency
    const r = s.det.push(luma, t);
    s.last = { luma, base: s.det.base, thr: r.threshold };
    let mark = 0;
    if (r.spike && running) {
      if (s.osc.inSelfWindow(t)) { // our own torch reflection: use it to self-calibrate torch lag
        s.ign++; mark = 1;
        if (s.echoAwait) { s.echoAwait = false; const echo = t - s.osc.lastFire; s.echo = echo;
          const lag = Math.min(300, Math.max(0, echo - camLat)); s.osc.torchLagMs = s.osc.torchLagMs ? s.osc.torchLagMs * 0.8 + lag * 0.2 : lag; }
      } else { s.dets++; mark = 2; s.osc.onFlash(t, camLat); }
    }
    s.graph.push([luma, mark]); if (s.graph.length > GRAPH_N) s.graph.shift();
  }, [running]);

  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    onFrame: useCallback((frame) => {
      'worklet';
      try {
        // Y (luma) plane, sampled on a sparse grid over the central 60% of the image
        let buf, w = frame.width, h = frame.height, row = frame.bytesPerRow;
        if (frame.isPlanar) { const p = frame.getPlanes()[0]; buf = p.getPixelBuffer(); w = p.width; h = p.height; row = p.bytesPerRow; }
        else buf = frame.getPixelBuffer();
        const px = new Uint8Array(buf); let sum = 0, n = 0;
        const y0 = Math.floor(h * 0.2), y1 = Math.floor(h * 0.8), x0 = Math.floor(w * 0.2), x1 = Math.floor(w * 0.8);
        for (let y = y0; y < y1; y += 8) { const o = y * row; for (let x = x0; x < x1; x += 8) { sum += px[o + x]; n++; } }
        scheduleOnRN(onLuma, n ? sum / n : 0);
      } finally { frame.dispose(); }
    }, [onLuma]),
  });

  if (!hasPermission) return <View style={st_.c}><Text style={st_.t}>Camera permission needed</Text><Btn label="Grant" onPress={requestPermission} /></View>;
  const g = ui.graph, gmax = Math.max(1, ...g.map(v => v[0]));
  return (
    <View style={[st_.c, flashOn && running && { backgroundColor: '#fff' }]}>
      <StatusBar hidden />
      <Camera ref={camRef} style={st_.cam} device="back" isActive={running} outputs={[frameOutput]}
        torchMode={useCtl ? undefined : torchProp} onError={(e) => console.warn(e)} />
      <Text style={st_.title}>Firefly Net v0.1</Text>
      <View style={st_.box}>
        <Text style={st_.m}>fps {ui.fps.toFixed(1)}   luma {ui.luma?.toFixed(1)}   base {ui.base?.toFixed(1)}   thr +{ui.thr?.toFixed(1)}</Text>
        <Text style={st_.m}>detections {ui.det}   own-echo ignored {ui.ign}   nudges {ui.nudges ?? 0}</Text>
        <Text style={st_.m}>phase {ui.phase.toFixed(2)}   torch {flashOn ? 'ON' : 'off'}   echo {ui.echo.toFixed(0)}ms   lag-comp {ui.lag.toFixed(0)}ms</Text>
        <View style={st_.phaseBar}><View style={[st_.phaseFill, { width: `${ui.phase * 100}%` }]} /></View>
        <View style={st_.graph}>
          {g.map(([v, m], i) => <View key={i} style={{ width: 3, marginRight: 1, height: 2 + 76 * v / gmax, backgroundColor: m === 2 ? '#ffd23f' : m === 1 ? '#666' : '#4fc3f7' }} />)}
        </View>
        <Text style={st_.s}>yellow = external flash (nudge), grey = own flash echo (ignored)</Text>
      </View>
      <View style={st_.row}>
        <Btn label={running ? 'Stop' : 'Start'} onPress={() => setRunning(r => !r)} big />
      </View>
      <View style={st_.row}>
        <Btn label="coupling -" onPress={() => setCoupling(c => Math.max(0.02, +(c - 0.05).toFixed(2)))} />
        <Text style={st_.t}>{coupling.toFixed(2)}</Text>
        <Btn label="coupling +" onPress={() => setCoupling(c => Math.min(0.8, +(c + 0.05).toFixed(2)))} />
        <Btn label={useCtl ? 'torch: ctl' : 'torch: prop'} onPress={() => setUseCtl(u => !u)} />
      </View>
    </View>
  );
}

const Btn = ({ label, onPress, big }) => (
  <Pressable onPress={onPress} style={[st_.btn, big && st_.big]}><Text style={[st_.bt, big && { fontSize: 22 }]}>{label}</Text></Pressable>
);

const st_ = StyleSheet.create({
  c: { flex: 1, backgroundColor: '#05070d', alignItems: 'center', justifyContent: 'center', padding: 12 },
  cam: { width: 120, height: 160, position: 'absolute', top: 40, right: 12, borderRadius: 8, overflow: 'hidden' },
  title: { color: '#ffd23f', fontSize: 24, fontWeight: '700', marginBottom: 12 },
  box: { backgroundColor: '#000a', padding: 10, borderRadius: 10, width: '100%' },
  m: { color: '#cde', fontFamily: 'monospace', fontSize: 12, marginBottom: 3 },
  s: { color: '#789', fontSize: 11, marginTop: 4 },
  t: { color: '#fff', fontSize: 16, marginHorizontal: 8 },
  phaseBar: { height: 8, backgroundColor: '#223', borderRadius: 4, marginVertical: 6 },
  phaseFill: { height: 8, backgroundColor: '#ffd23f', borderRadius: 4 },
  graph: { height: 80, flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#0b1020', overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 14, flexWrap: 'wrap', justifyContent: 'center' },
  btn: { backgroundColor: '#1d2a44', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, margin: 4 },
  big: { backgroundColor: '#ffb300', paddingHorizontal: 50, paddingVertical: 16 },
  bt: { color: '#fff', fontWeight: '600' },
});
