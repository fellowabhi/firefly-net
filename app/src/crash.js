// Crash capture for v0.3.1: JS global error handler, unhandled-rejection tracker, launch-stage marker
// (detects native crashes that no handler can catch, e.g. SIGSEGV), and native crash file read-back.
import { File, Paths } from 'expo-file-system';
import N from '../modules/firefly-native';

const jsCrash = () => new File(Paths.document, 'firefly-js-crash.txt');
const marker = () => new File(Paths.document, 'firefly-launch.json');
const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
const write = (f, text) => safe(() => { f.create({ overwrite: true }); f.write(text); return true; }, false);
const read = (f) => safe(() => (f.exists ? f.textSync() : ''), '');
export const deviceInfo = () => safe(() => N.deviceInfo(), 'unknown device');
export const errText = (e) => (e && (e.stack || e.message)) ? `${e.message || ''}\n${e.stack || ''}` : String(e);

let onNonFatal = null;
export function setNonFatalSink(fn) { onNonFatal = fn; }

export function installJsHandlers() {
  const EU = global.ErrorUtils;
  if (EU && !EU.__ff) {
    const prev = EU.getGlobalHandler();
    EU.setGlobalHandler((e, isFatal) => {
      const text = `Firefly Net JS ${isFatal ? 'FATAL' : 'error'}\ntime: ${new Date().toISOString()}\ndevice: ${deviceInfo()}\nstage: ${currentStage}\n\n${errText(e)}`;
      if (isFatal) write(jsCrash(), text); else onNonFatal?.(text);
      prev?.(e, isFatal);
    });
    EU.__ff = true;
  }
  safe(() => global.HermesInternal?.enablePromiseRejectionTracker?.({ allRejections: true,
    onUnhandled: (id, e) => onNonFatal?.(`unhandled promise rejection: ${errText(e)}`), onHandled: () => {} }));
}

// Launch-stage marker: written at each risky step; marked 'ok' after the app ran fine for a while.
let currentStage = 'boot';
export function readPreviousLaunch() { const t = read(marker()); return safe(() => (t ? JSON.parse(t) : null), null); }
export function setStage(stage) { currentStage = stage; write(marker(), JSON.stringify({ stage, t: new Date().toISOString() })); }

// Collect everything from the previous session that indicates a crash.
export function collectLastCrash(prevLaunch) {
  const parts = [];
  const nat = safe(() => N.getLastCrash(), ''); if (nat) parts.push(nat);
  const js = read(jsCrash()); if (js) parts.push(js);
  if (prevLaunch && prevLaunch.stage !== 'ok' && prevLaunch.stage !== 'closed' && !parts.length)
    parts.push(`App closed unexpectedly during stage "${prevLaunch.stage}" (${prevLaunch.t}).\nNo Java/JS stack was captured, so this was likely a native (C++) crash or the system killed the app.\ndevice: ${deviceInfo()}`);
  return parts.join('\n\n----\n\n');
}
export function clearLastCrash() { safe(() => N.clearLastCrash()); safe(() => { const f = jsCrash(); if (f.exists) f.delete(); }); }
