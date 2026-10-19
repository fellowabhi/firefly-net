// Firefly Net v0.3: BLE-advert consensus sync (default), experimental audio chirps, camera only for torch-lag calibration.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StatusBar, ScrollView, Animated, PermissionsAndroid, Platform, useWindowDimensions, StyleSheet } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { scheduleOnRN } from 'react-native-worklets';
import { Camera, useFrameOutput, CommonResolutions } from 'react-native-vision-camera';
import N from './modules/firefly-native';
import { Engine } from './src/engine';
import { C } from './src/ui';
import { NormalView, DebugView, Seg } from './src/views';

async function askPermissions(audio) {
  if (Platform.OS !== 'android') return true;
  const P = PermissionsAndroid.PERMISSIONS, want = [P.CAMERA];
  if (Platform.Version >= 31) want.push(P.BLUETOOTH_SCAN, P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT); else want.push(P.ACCESS_FINE_LOCATION);
  if (audio) want.push(P.RECORD_AUDIO);
  const r = await PermissionsAndroid.requestMultiple(want);
  return Object.fromEntries(want.map(k => [k, r[k] === 'granted']));
}

export default function App() {
  useKeepAwake();
  const { width } = useWindowDimensions();
  const [view, setView] = useState('normal');
  const [snap, setSnap] = useState(null);
  const [channel, setChannel] = useState('ble');
  const [output, setOutput] = useState('torch');
  const [camOn, setCamOn] = useState(false);
  const [toast, setToast] = useState('');
  const camRef = useRef(null), flash = useRef(new Animated.Value(0)).current, tsOff = useRef(null);

  const engine = useMemo(() => new Engine({
    torch: (on) => { const ctl = camRef.current?.controller; if (!ctl) { engine.log('torch_err', 'camera not ready'); return; }
      const t0 = N.nowMs(); ctl.setTorchMode(on ? 'on' : 'off').then(() => engine.log('torch_ack', on ? 1 : 0, N.nowMs() - t0)).catch(e => engine.log('torch_err', String(e?.message || e))); },
    screenFlash: () => { flash.setValue(1); Animated.timing(flash, { toValue: 0, duration: 380, useNativeDriver: true }).start(); },
    lockExposure: async () => { const ctl = camRef.current?.controller; if (!ctl) return 'no camera';
      try { await ctl.lockCurrentExposure(); return 'locked'; } catch (e) { return 'lock failed: ' + (e?.message || e); } },
    ready: () => !!camRef.current?.controller,
  }), []);

  const startAll = useCallback(async () => {
    const perms = await askPermissions(engine.channel === 'audio');
    engine.permissions = perms;
    setCamOn(engine.output === 'torch');
    await new Promise(r => setTimeout(r, 600)); // let the camera open before calibration
    engine.start();
  }, []);
  useEffect(() => { startAll(); const iv = setInterval(() => setSnap(engine.snapshot()), 40); return () => { clearInterval(iv); engine.stop(); }; }, []);

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 1600); };
  const restart = () => { engine.stop(); engine.start(); showToast('Restarted, random phase'); };
  const recal = () => { if (engine.output !== 'torch') return; engine.torchLag = null; engine.stop(); engine.start(); showToast('Recalibrating torch lag'); };
  const onChannel = async (ch) => {
    if (ch === 'audio') { const p = await askPermissions(true); if (!p[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]) { showToast('Microphone permission needed'); return; } }
    setChannel(ch); engine.setChannel(ch);
  };
  const onOutput = (o) => { setOutput(o); setCamOn(o === 'torch'); setTimeout(() => engine.setOutput(o), o === 'torch' ? 700 : 0); };
  const exportCsv = async () => {
    try { const f = new File(Paths.cache, `firefly-net-v0.3-${Date.now()}.csv`); f.create({ overwrite: true }); f.write(engine.csvText());
      await Sharing.shareAsync(f.uri, { mimeType: 'text/csv', dialogTitle: 'Share Firefly Net log' }); }
    catch (e) { showToast('Export failed: ' + (e?.message || e)); }
  };

  // camera frames -> mean luma (centre 60%, sparse grid) -> engine (torch-lag echo tracking + calibration)
  const onLuma = useCallback((luma, tsRaw) => {
    const recv = N.nowMs(); const ts = tsRaw > 1e11 ? tsRaw / 1e6 : tsRaw > 0 ? tsRaw : recv; const d = recv - ts;
    if (tsOff.current == null || d < tsOff.current || d - tsOff.current > 2000) tsOff.current = d; else tsOff.current += 0.002;
    engine.frame(ts + tsOff.current, luma);
  }, []);
  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.VGA_4_3, pixelFormat: 'yuv', dropFramesWhileBusy: true,
    onFrame: useCallback((frame) => {
      'worklet';
      try {
        let buf, w = frame.width, h = frame.height, row = frame.bytesPerRow;
        if (frame.isPlanar) { const p = frame.getPlanes()[0]; buf = p.getPixelBuffer(); w = p.width; h = p.height; row = p.bytesPerRow; } else buf = frame.getPixelBuffer();
        const px = new Uint8Array(buf); let sum = 0, n = 0;
        const y0 = Math.floor(h * 0.2), y1 = Math.floor(h * 0.8), x0 = Math.floor(w * 0.2), x1 = Math.floor(w * 0.8);
        for (let y = y0; y < y1; y += 8) { const o = y * row; for (let x = x0; x < x1; x += 8) { sum += px[o + x]; n++; } }
        scheduleOnRN(onLuma, n ? sum / n : 0, frame.timestamp);
      } finally { frame.dispose(); }
    }, [onLuma]),
  });

  return (
    <View style={s.app}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {camOn && <Camera ref={camRef} style={s.cam} device="back" isActive={camOn} outputs={[frameOutput]} constraints={[{ fps: 30 }]} onError={(e) => engine.log('status', 'camera_error', String(e?.message || e))} />}
      <View style={s.top}>
        <View style={s.brand}><View style={s.dot} /><Text style={s.brandT}>Firefly</Text><Text style={[s.brandT, { color: C.dim, fontWeight: '500' }]}>Net</Text><Text style={s.ver}>v0.3</Text></View>
        <Seg value={view} onChange={setView} options={[{ v: 'normal', label: 'Normal' }, { v: 'debug', label: 'Debug' }]} />
      </View>
      {view === 'normal'
        ? <NormalView s={snap} width={width} onRestart={restart} onDebug={() => setView('debug')} />
        : <ScrollView contentContainerStyle={{ paddingHorizontal: 12 }}><DebugView s={snap} width={width} channel={channel} output={output} onChannel={onChannel} onOutput={onOutput} onRestart={restart} onExport={exportCsv} onRecal={recal} /></ScrollView>}
      {output === 'screen' && <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, view === 'normal' ? s.sflash : s.sflashDbg, { opacity: flash }]} />}
      {!!toast && <View style={s.toast}><Text style={s.toastT}>{toast}</Text></View>}
    </View>
  );
}

const s = StyleSheet.create({
  app: { flex: 1, backgroundColor: C.bg },
  cam: { position: 'absolute', width: 2, height: 2, opacity: 0.01, top: 0, left: 0 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 34, paddingBottom: 8 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 }, dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.ff, shadowColor: C.ff, shadowOpacity: 1, shadowRadius: 8, elevation: 6 },
  brandT: { color: C.txt, fontSize: 16, fontWeight: '700' }, ver: { color: '#6a7682', fontFamily: 'monospace', fontSize: 8, fontWeight: '600', backgroundColor: C.tile, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3, marginLeft: 4 },
  sflash: { backgroundColor: '#f2ffc8', zIndex: 4 }, sflashDbg: { borderWidth: 4, borderColor: '#e9ffb0', zIndex: 4 },
  toast: { position: 'absolute', alignSelf: 'center', bottom: 28, backgroundColor: '#18210f', paddingVertical: 9, paddingHorizontal: 14, borderRadius: 10, zIndex: 6 }, toastT: { color: C.ff, fontFamily: 'monospace', fontSize: 12, fontWeight: '600' },
});
