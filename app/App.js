// Firefly Net v0.3.1: BLE-advert consensus sync (default), experimental audio chirps, camera only for torch-lag calibration.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Component, } from 'react';
import { View, Text, Pressable, StatusBar, ScrollView, Animated, PermissionsAndroid, Platform, useWindowDimensions, StyleSheet, Share, AppState } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { scheduleOnRN } from 'react-native-worklets';
import { Camera, useFrameOutput, CommonResolutions } from 'react-native-vision-camera';
import N from './modules/firefly-native';
import { Engine } from './src/engine';
import { C } from './src/ui';
import { NormalView, DebugView, Seg } from './src/views';
import { installJsHandlers, readPreviousLaunch, collectLastCrash, clearLastCrash, setStage, setNonFatalSink, deviceInfo, errText } from './src/crash';

// ---- crash capture runs before anything else ----
installJsHandlers();
const PREV = readPreviousLaunch();
const LAST_CRASH = collectLastCrash(PREV);
// previous launch died while the camera was starting/calibrating -> start without the camera this time
const SAFE_MODE = !!PREV && ['camera', 'calibration', 'permissions'].includes(PREV.stage);
// previous launch died while starting Bluetooth -> don't auto-start BLE once (Restart retries)
const SAFE_BLE = !!PREV && PREV.stage === 'bluetooth';
setStage('boot');

class Boundary extends Component { // render errors show a card instead of killing the app
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { this.props.onError?.(err); }
  render() { if (!this.state.err) return this.props.children;
    return <View style={{ padding: 16 }}><Text style={{ color: C.red, fontWeight: '700' }}>UI error (app still running)</Text><Text style={{ color: C.dim, fontFamily: 'monospace', fontSize: 11 }}>{String(this.state.err?.message || this.state.err)}</Text>
      <Pressable onPress={() => this.setState({ err: null })} style={{ marginTop: 8, backgroundColor: C.tile, padding: 10, borderRadius: 10 }}><Text style={{ color: C.txt }}>Retry</Text></Pressable></View>; }
}
function CrashCard({ text, onShare, onDismiss }) {
  return <View style={s.crash}><Text style={s.crashH}>Last crash</Text>
    <Text style={s.crashT} numberOfLines={7}>{text}</Text>
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
      <Pressable style={s.crashB} onPress={onShare}><Text style={s.crashBT}>Share / copy</Text></Pressable>
      <Pressable style={[s.crashB, { backgroundColor: C.tile }]} onPress={onDismiss}><Text style={[s.crashBT, { color: C.dim }]}>Dismiss</Text></Pressable></View></View>;
}

async function askPermissions(audio) {
  if (Platform.OS !== 'android') return {};
  const P = PermissionsAndroid.PERMISSIONS, want = [P.CAMERA];
  if (Platform.Version >= 31) want.push(P.BLUETOOTH_SCAN, P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT); else want.push(P.ACCESS_FINE_LOCATION);
  if (audio) want.push(P.RECORD_AUDIO);
  try { const r = await PermissionsAndroid.requestMultiple(want); return Object.fromEntries(want.map(k => [k, r[k] === 'granted'])); } catch (e) { return {}; }
}

export default function App() {
  useKeepAwake();
  const { width } = useWindowDimensions();
  const [view, setView] = useState('normal');
  const [snap, setSnap] = useState(null);
  const [channel, setChannel] = useState('ble');
  const [output, setOutput] = useState(SAFE_MODE ? 'screen' : 'torch');
  const [crash, setCrash] = useState(LAST_CRASH);
  const [camOn, setCamOn] = useState(false);
  const [toast, setToast] = useState('');
  const camOnRef = useRef(false), camRef = useRef(null), flash = useRef(new Animated.Value(0)).current, tsOff = useRef(null);

  const engine = useMemo(() => new Engine({
    torch: (on) => { try { const ctl = camRef.current?.controller; if (!ctl) { engine.log('torch_err', 'camera not ready'); return; }
      const t0 = N.nowMs(); ctl.setTorchMode(on ? 'on' : 'off').then(() => engine.log('torch_ack', on ? 1 : 0, N.nowMs() - t0)).catch(e => engine.log('torch_err', String(e?.message || e))); } catch (e) { engine.log('torch_err', String(e?.message || e)); } },
    outputChanged: (o) => { setOutput(o); setCamOn(o === 'torch'); },
    screenFlash: () => { flash.setValue(1); Animated.timing(flash, { toValue: 0, duration: 380, useNativeDriver: true }).start(); },
    lockExposure: async () => { const ctl = camRef.current?.controller; if (!ctl) return 'no camera';
      try { await ctl.lockCurrentExposure(); return 'locked'; } catch (e) { return 'lock failed: ' + (e?.message || e); } },
    ready: () => { try { return !!camRef.current?.controller; } catch (e) { return false; } },
  }), []);

  const startAll = useCallback(async () => {
    try {
      setNonFatalSink((t) => engine.log('js_error', t.split('\n').slice(0, 3).join(' | ')));
      engine.log('status', 'device', deviceInfo()); if (SAFE_BLE) engine.skipBleOnce = true; if (SAFE_MODE) { engine.output = 'screen'; engine.warn = 'Safe mode: the last launch crashed while starting the camera, so the torch is off. Switch to Torch in Debug to retry.'; }
      setStage('permissions');
      const perms = await askPermissions(engine.channel === 'audio');
      engine.permissions = perms; engine.log('status', 'permissions', JSON.stringify(perms));
      if (perms[PermissionsAndroid.PERMISSIONS.CAMERA] === false && engine.output === 'torch') { engine.output = 'screen'; setOutput('screen'); engine.warn = 'Camera permission denied: flashing with the screen.'; }
      if (engine.output === 'torch') { setStage('camera'); setCamOn(true); await new Promise(r => setTimeout(r, 600)); } // let the camera open before calibration
      await engine.start();
    } catch (e) { engine.jsError('startAll', e); }
  }, []);
  useEffect(() => {
    startAll(); const iv = setInterval(() => { try { setSnap(engine.snapshot()); } catch (e) {} }, 40);
    const as = AppState.addEventListener('change', (st) => { if (st === 'background') setStage('closed'); else if (st === 'active') setStage('running'); });
    return () => { clearInterval(iv); as.remove(); engine.stop(); };
  }, []);
  const shareCrash = () => { Share.share({ message: crash }).catch(() => {}); };
  const dismissCrash = () => { clearLastCrash(); setCrash(''); };

  camOnRef.current = camOn;
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 1600); };
  const restart = () => { engine.stop(); engine.start().catch(e => engine.jsError('restart', e)); showToast('Restarted, random phase'); };
  const recal = () => { if (engine.output !== 'torch') return; engine.torchLag = null; engine.stop(); engine.start().catch(e => engine.jsError('recal', e)); showToast('Recalibrating torch lag'); };
  const onChannel = async (ch) => { try {
    if (ch === 'audio') { const p = await askPermissions(true); if (!p[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]) { showToast('Microphone permission needed'); return; } }
    setChannel(ch); engine.setChannel(ch); } catch (e) { engine.jsError('channel', e); } };
  const onOutput = (o) => { setOutput(o); setCamOn(o === 'torch'); if (o === 'torch') setStage('camera'); setTimeout(() => engine.setOutput(o).catch(e => engine.jsError('output', e)), o === 'torch' ? 700 : 0); };
  const exportCsv = async () => {
    try { const f = new File(Paths.cache, `firefly-net-v0.3.1-${Date.now()}.csv`); f.create({ overwrite: true }); f.write(engine.csvText());
      await Sharing.shareAsync(f.uri, { mimeType: 'text/csv', dialogTitle: 'Share Firefly Net log' }); }
    catch (e) { showToast('Export failed: ' + (e?.message || e)); }
  };

  // camera frames -> mean luma (centre 60%, sparse grid) -> engine (torch-lag echo tracking + calibration)
  const onLuma = useCallback((luma, tsRaw) => {
    if (!camOnRef.current) return;
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
      {camOn && <Boundary onError={(e) => engine.cameraError('render ' + (e?.message || e))}><Camera ref={camRef} style={s.cam} device="back" isActive={camOn} outputs={[frameOutput]} onError={(e) => engine.cameraError(String(e?.message || e))} /></Boundary>}
      <View style={s.top}>
        <View style={s.brand}><View style={s.dot} /><Text style={s.brandT}>Firefly</Text><Text style={[s.brandT, { color: C.dim, fontWeight: '500' }]}>Net</Text><Text style={s.ver}>v0.3.1</Text></View>
        <Seg value={view} onChange={setView} options={[{ v: 'normal', label: 'Normal' }, { v: 'debug', label: 'Debug' }]} />
      </View>
      {!!crash && view === 'normal' && <CrashCard text={crash} onShare={shareCrash} onDismiss={dismissCrash} />}
      {snap?.btOff && view === 'normal' && <Pressable style={s.bt} onPress={() => { try { N.openBluetoothSettings(); } catch (e) {} }}><Text style={s.btT}>Bluetooth is off — tap to open Bluetooth settings. Flashing continues on its own.</Text></Pressable>}
      <Boundary onError={(e) => engine.jsError('render', e)}>
      {view === 'normal'
        ? <NormalView s={snap} width={width} onRestart={restart} onDebug={() => setView('debug')} />
        : <ScrollView contentContainerStyle={{ paddingHorizontal: 12 }}>
            {!!crash && <CrashCard text={crash} onShare={shareCrash} onDismiss={dismissCrash} />}
            <DebugView s={snap} width={width} channel={channel} output={output} onChannel={onChannel} onOutput={onOutput} onRestart={restart} onExport={exportCsv} onRecal={recal} /></ScrollView>}
      </Boundary>
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
  crash: { marginHorizontal: 12, marginBottom: 7, backgroundColor: '#1a0f10', borderRadius: 14, padding: 10 }, crashH: { color: C.red, fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  crashT: { color: '#c9a3a3', fontFamily: 'monospace', fontSize: 10 }, crashB: { backgroundColor: 'rgba(255,90,90,0.15)', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8 }, crashBT: { color: C.red, fontWeight: '600', fontSize: 12 },
  bt: { marginHorizontal: 12, marginBottom: 6, backgroundColor: 'rgba(90,209,255,0.12)', borderRadius: 12, padding: 10 }, btT: { color: C.blue, fontSize: 12, fontWeight: '600' },
  toast: { position: 'absolute', alignSelf: 'center', bottom: 28, backgroundColor: '#18210f', paddingVertical: 9, paddingHorizontal: 14, borderRadius: 10, zIndex: 6 }, toastT: { color: C.ff, fontFamily: 'monospace', fontSize: 12, fontWeight: '600' },
});
