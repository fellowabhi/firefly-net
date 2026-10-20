package expo.modules.fireflynative

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.media.*
import android.os.*
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import kotlin.math.*

// Firefly Net native side (v0.3.1: defensive).
// Every entry point and every callback is wrapped: failures become "onStatus" events (kind ends with
// "_error"), never exceptions on binder / handler threads (those kill the process).
// A process-wide uncaught-exception logger writes filesDir/firefly-crash.txt; JS shows it next launch.
// Clock: SystemClock.elapsedRealtime (ms, double). ScanResult.timestampNanos and AudioTimestamp
// TIMEBASE_BOOTTIME are on the same clock.
class FireflyNativeModule : Module() {
  private val ctxOrNull: Context? get() = try { appContext.reactContext } catch (_: Throwable) { null }
  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private fun h(): Handler { if (handler == null) { val t = HandlerThread("firefly-ble").apply { start() }; thread = t; handler = Handler(t.looper) }; return handler!! }
  private fun now() = SystemClock.elapsedRealtimeNanos() / 1e6

  @Volatile private var nextAt = 0.0
  @Volatile private var periodMs = 1000.0
  @Volatile private var flags = 0

  private fun stack(t: Throwable): String { val sw = StringWriter(); t.printStackTrace(PrintWriter(sw)); return sw.toString() }
  private fun status(kind: String, msg: String) { try { sendEvent("onStatus", mapOf("kind" to kind, "msg" to msg, "t" to now())) } catch (_: Throwable) {} }
  private inline fun safe(where: String, block: () -> Unit) { try { block() } catch (t: Throwable) { status("native_error", "$where: ${t.javaClass.simpleName}: ${t.message}") } }

  // ---------------- crash logger ----------------
  private fun crashFile(c: Context) = File(c.filesDir, "firefly-crash.txt")
  private fun installCrashLogger() {
    val c = ctxOrNull?.applicationContext ?: return
    val prev = Thread.getDefaultUncaughtExceptionHandler()
    if (prev is FireflyCrashHandler) return
    Thread.setDefaultUncaughtExceptionHandler(FireflyCrashHandler(crashFile(c), prev))
  }
  class FireflyCrashHandler(private val f: File, private val prev: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(t: Thread, e: Throwable) {
      try {
        val sw = StringWriter(); e.printStackTrace(PrintWriter(sw))
        f.writeText("Firefly Net native crash\ntime: ${java.util.Date()}\nthread: ${t.name}\ndevice: ${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE}), Android ${Build.VERSION.RELEASE} SDK ${Build.VERSION.SDK_INT}\n\n$sw")
      } catch (_: Throwable) {}
      prev?.uncaughtException(t, e)
    }
  }

  // ---------------- permissions / state ----------------
  private fun has(c: Context, p: String) = c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
  private fun adapter(c: Context): BluetoothAdapter? = try { (c.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter } catch (_: Throwable) { null }
  private fun btState(): Map<String, Any?> {
    val c = ctxOrNull ?: return mapOf("ok" to false, "reason" to "no context")
    val a = adapter(c)
    val s31 = Build.VERSION.SDK_INT >= 31
    val scanP = if (s31) has(c, Manifest.permission.BLUETOOTH_SCAN) else has(c, Manifest.permission.ACCESS_FINE_LOCATION)
    val advP = if (s31) has(c, Manifest.permission.BLUETOOTH_ADVERTISE) else true
    val connP = if (s31) has(c, Manifest.permission.BLUETOOTH_CONNECT) else true
    val enabled = try { a?.isEnabled == true } catch (_: Throwable) { false }
    val locOn = try { val lm = c.getSystemService(Context.LOCATION_SERVICE) as LocationManager; if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled else true } catch (_: Throwable) { true }
    val ext = try { if (enabled && Build.VERSION.SDK_INT >= 26) a?.isLeExtendedAdvertisingSupported == true else false } catch (_: Throwable) { false }
    return mapOf("adapter" to (a != null), "enabled" to enabled, "scanPerm" to scanP, "advPerm" to advP, "connectPerm" to connP, "locationOn" to locOn,
      "needsLocation" to !s31, "extAdv" to ext, "sdk" to Build.VERSION.SDK_INT, "device" to "${Build.MANUFACTURER} ${Build.MODEL}", "bleRunning" to bleOn, "advMode" to advMode)
  }
  private var btReceiver: BroadcastReceiver? = null
  private fun registerBtReceiver() {
    val c = ctxOrNull?.applicationContext ?: return
    if (btReceiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, i: Intent?) { safe("bt_state") {
        val st = i?.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1) ?: -1
        val on = st == BluetoothAdapter.STATE_ON
        if (st == BluetoothAdapter.STATE_ON || st == BluetoothAdapter.STATE_OFF) {
          sendEvent("onBtState", mapOf("on" to on, "t" to now()))
          if (!on) { bleOn = false; advSet = null; advCb = null; legacyCb = null; scanCb = null; h().removeCallbacks(updater) } // stack tears these down itself
        }
      } }
    }
    try { if (Build.VERSION.SDK_INT >= 33) c.registerReceiver(r, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), Context.RECEIVER_EXPORTED)
          else c.registerReceiver(r, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)); btReceiver = r } catch (t: Throwable) { status("native_error", "bt receiver: ${t.message}") }
  }

  // ---------------- BLE ----------------
  private val COMPANY = 0xFFFF
  private var myId = 0L
  private var seq = 0
  @Volatile private var advSet: AdvertisingSet? = null
  private var advCb: AdvertisingSetCallback? = null
  private var legacyCb: AdvertiseCallback? = null
  private var scanCb: ScanCallback? = null
  private var updateMs = 100L
  private var advUpdates = 0; private var advErrors = 0; private var rxCount = 0
  private var lastSetCall = 0.0; @Volatile private var applyLatMs = 0.0
  @Volatile private var bleOn = false
  @Volatile private var advMode = "none"  // "set" (in-place updates) | "legacy" (restart to update) | "none"
  private val scanStarts = ArrayDeque<Double>()

  private fun ttf(t: Double): Int {
    val p = if (periodMs.isFinite() && periodMs > 0) periodMs else 1000.0
    if (!nextAt.isFinite() || !t.isFinite()) return 0
    var d = (nextAt - t) % p; if (d < 0) d += p
    return if (d.isFinite()) d.roundToInt().coerceIn(0, 65535) else 0
  }
  private fun payload(): ByteArray {
    val t = ttf(now() + applyLatMs)
    val p = (if (periodMs.isFinite()) periodMs else 1000.0).roundToInt().coerceIn(1, 65535); val id = myId
    seq = (seq + 1) and 255
    return byteArrayOf(0x46, 0x03, (id and 255).toByte(), ((id shr 8) and 255).toByte(), ((id shr 16) and 255).toByte(), ((id shr 24) and 255).toByte(),
      seq.toByte(), (t and 255).toByte(), (t shr 8).toByte(), (p and 255).toByte(), (p shr 8).toByte(), flags.toByte())
  }
  // 2 (AD hdr) + 2 (company) + 12 = 16 bytes: fits legacy 31-byte adverts, no name / tx power
  private fun advData() = AdvertiseData.Builder().setIncludeDeviceName(false).setIncludeTxPowerLevel(false).addManufacturerData(COMPANY, payload()).build()

  private val updater: Runnable = object : Runnable {
    @SuppressLint("MissingPermission")
    override fun run() {
      try {
        if (!bleOn) return
        val s = advSet
        if (advMode == "set" && s != null) { lastSetCall = now(); s.setAdvertisingData(advData()) }
        else if (advMode == "legacy") restartLegacy()
      } catch (t: Throwable) { advErrors++; if (advErrors % 50 == 1) status("adv_error", "update: ${t.javaClass.simpleName}: ${t.message}") }
      if (bleOn) h().postDelayed(this, if (advMode == "legacy") max(updateMs, 250L) else updateMs)
    }
  }

  @SuppressLint("MissingPermission")
  private fun restartLegacy() {
    val c = ctxOrNull ?: return; val adv = adapter(c)?.bluetoothLeAdvertiser ?: return
    legacyCb?.let { try { adv.stopAdvertising(it) } catch (_: Throwable) {} }
    val cb = object : AdvertiseCallback() {
      override fun onStartSuccess(s: AdvertiseSettings?) { advUpdates++ }
      override fun onStartFailure(code: Int) { advErrors++; if (advErrors % 20 == 1) status("adv_error", "legacy advertise failed code=$code (${advCode(code)})") }
    }
    legacyCb = cb
    val st = AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY).setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH).setConnectable(false).setTimeout(0).build()
    adv.startAdvertising(st, advData(), cb)
  }
  private fun advCode(c: Int) = when (c) { 1 -> "data too large"; 2 -> "too many advertisers"; 3 -> "already started"; 4 -> "internal error"; 5 -> "feature unsupported"; else -> "code $c" }

  @SuppressLint("MissingPermission")
  private fun startBle(id: Double, intervalMs: Int): String {
    val c = ctxOrNull ?: return "no context"
    val st = btState()
    if (st["adapter"] != true) return "no bluetooth adapter"
    if (st["enabled"] != true) return "bluetooth is off"
    if (st["scanPerm"] != true || st["advPerm"] != true) return "missing Nearby devices permission"
    stopBle()
    val a = adapter(c) ?: return "no bluetooth adapter"
    myId = (if (id.isFinite()) id.toLong() else 1L) and 0xFFFFFFFFL; updateMs = intervalMs.toLong().coerceAtLeast(50); bleOn = true
    val msgs = mutableListOf<String>()
    // ---- advertiser: AdvertisingSet (in-place data updates), fall back to legacy start/stop ----
    val adv = try { a.bluetoothLeAdvertiser } catch (t: Throwable) { null }
    if (adv == null) msgs.add("advertising unavailable") else {
      try {
        val params = AdvertisingSetParameters.Builder().setLegacyMode(true).setConnectable(false).setScannable(false)
          .setInterval(AdvertisingSetParameters.INTERVAL_MIN).setTxPowerLevel(AdvertisingSetParameters.TX_POWER_HIGH).build()
        val cb = object : AdvertisingSetCallback() {
          override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, s: Int) { safe("adv_started") {
            if (s == ADVERTISE_SUCCESS && set != null) { advSet = set; advMode = "set"; status("adv", "advertising started (set) tx=$txPower"); h().removeCallbacks(updater); h().post(updater) }
            else { status("adv_error", "advertising set failed code=$s (${advCode(s)}) → legacy fallback"); advMode = "legacy"; h().removeCallbacks(updater); h().post(updater) }
          } }
          override fun onAdvertisingDataSet(set: AdvertisingSet?, s: Int) { safe("adv_data") {
            if (s == ADVERTISE_SUCCESS) { advUpdates++; val l = now() - lastSetCall; if (l in 0.0..500.0) applyLatMs = if (applyLatMs == 0.0) l else applyLatMs * 0.9 + l * 0.1 }
            else { advErrors++; if (advErrors % 50 == 1) status("adv_error", "data update failed code=$s") }
          } }
          override fun onAdvertisingSetStopped(set: AdvertisingSet?) { safe("adv_stopped") { if (advSet === set) advSet = null } }
        }
        advCb = cb
        adv.startAdvertisingSet(params, advData(), null, null, null, cb)
      } catch (t: Throwable) {
        msgs.add("set: ${t.javaClass.simpleName}"); advCb = null; advMode = "legacy"
        try { restartLegacy(); h().removeCallbacks(updater); h().postDelayed(updater, 250) } catch (t2: Throwable) { msgs.add("legacy: ${t2.javaClass.simpleName}: ${t2.message}"); advMode = "none" }
      }
    }
    // ---- scanner (throttled: Android blocks >5 startScan per 30 s per app) ----
    val nowT = now(); while (scanStarts.isNotEmpty() && nowT - scanStarts.first() > 30000) scanStarts.removeFirst()
    if (scanStarts.size >= 4) msgs.add("scan restart throttled, retry in ${((30000 - (nowT - scanStarts.first())) / 1000).roundToInt()} s")
    else {
      val sc = try { a.bluetoothLeScanner } catch (_: Throwable) { null }
      if (sc == null) msgs.add("scanning unavailable") else try {
        val filter = ScanFilter.Builder().setManufacturerData(COMPANY, byteArrayOf(0x46, 0x03), byteArrayOf(-1, -1)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
          .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE).setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT).setReportDelay(0).setLegacy(true).build()
        val scb = object : ScanCallback() {
          override fun onScanResult(type: Int, r: ScanResult) { safe("scan_result") { handle(r) } }
          override fun onBatchScanResults(rs: MutableList<ScanResult>) { safe("scan_batch") { rs.forEach { handle(it) } } }
          override fun onScanFailed(code: Int) { safe("scan_failed") { status("scan_error", "scan failed code=$code" + if (code == 6) " (scanning too frequently)" else if (code == 2) " (app registration failed — toggle Bluetooth)" else "") } }
        }
        scanCb = scb; scanStarts.addLast(nowT)
        sc.startScan(listOf(filter), settings, scb)
      } catch (t: Throwable) { msgs.add("scan: ${t.javaClass.simpleName}: ${t.message}"); scanCb = null }
    }
    return if (msgs.isEmpty()) "ok" else "partial: " + msgs.joinToString("; ")
  }

  private fun handle(r: ScanResult) {
    val b = r.scanRecord?.getManufacturerSpecificData(COMPANY) ?: return
    if (b.size < 12 || b[0] != 0x46.toByte() || b[1] != 0x03.toByte()) return
    val u = { i: Int -> b[i].toInt() and 255 }
    val id = (u(2).toLong() or (u(3).toLong() shl 8) or (u(4).toLong() shl 16) or (u(5).toLong() shl 24))
    if (id == myId) return
    rxCount++
    sendEvent("onAdv", mapOf("id" to id.toDouble(), "seq" to u(6), "ttf" to (u(7) or (u(8) shl 8)), "period" to (u(9) or (u(10) shl 8)),
      "flags" to u(11), "rssi" to r.rssi, "ts" to r.timestampNanos / 1e6, "rx" to now()))
  }

  @SuppressLint("MissingPermission")
  private fun stopBle() {
    bleOn = false; handler?.removeCallbacks(updater)
    val c = ctxOrNull; val a = c?.let { adapter(it) }
    val on = try { a?.isEnabled == true } catch (_: Throwable) { false }
    if (on) {
      try { advCb?.let { a?.bluetoothLeAdvertiser?.stopAdvertisingSet(it) } } catch (_: Throwable) {}
      try { legacyCb?.let { a?.bluetoothLeAdvertiser?.stopAdvertising(it) } } catch (_: Throwable) {}
      try { scanCb?.let { a?.bluetoothLeScanner?.stopScan(it) } } catch (_: Throwable) {}
    }
    advCb = null; legacyCb = null; scanCb = null; advSet = null; advMode = "none"
  }

  // ---------------- AUDIO (experimental) ----------------
  @Volatile private var audioOn = false
  private var outThread: Thread? = null; private var inThread: Thread? = null
  @Volatile private var freq = 18000.0; @Volatile private var chirpMs = 30.0; @Volatile private var thrRatio = 12.0

  @SuppressLint("MissingPermission")
  private fun startAudio(f: Double, cm: Double, thr: Double): String {
    val c = ctxOrNull ?: return "no context"
    if (!has(c, Manifest.permission.RECORD_AUDIO)) return "missing microphone permission"
    stopAudio(); freq = f; chirpMs = cm; thrRatio = thr; audioOn = true
    val rate = 48000
    outThread = Thread({
      var tr: AudioTrack? = null
      try {
        val minB = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        tr = AudioTrack.Builder()
          .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
          .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
          .setBufferSizeInBytes(max(minB, 4 * 480)).setTransferMode(AudioTrack.MODE_STREAM)
          .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY).build()
        val blk = 240; val buf = ShortArray(blk); var written = 0L; val ts = AudioTimestamp(); var lastChirp = -1e9
        tr.play()
        while (audioOn) {
          val monoToBoot = (SystemClock.elapsedRealtimeNanos() - System.nanoTime()) / 1e6
          val t0 = if (tr.getTimestamp(ts)) ts.nanoTime / 1e6 + monoToBoot + (written - ts.framePosition) * 1000.0 / rate
                   else now() + (written - tr.playbackHeadPosition.toLong()) * 1000.0 / rate
          val P = if (periodMs > 0) periodMs else 1000.0; var cc0 = nextAt; cc0 += floor((t0 - cc0) / P) * P
          java.util.Arrays.fill(buf, 0.toShort())
          for (cc in doubleArrayOf(cc0, cc0 + P)) {
            for (i in 0 until blk) { val dt = t0 + i * 1000.0 / rate - cc
              if (dt >= 0 && dt < chirpMs) { val w = 0.5 - 0.5 * cos(2 * PI * dt / chirpMs); buf[i] = (buf[i] + 26000 * w * sin(2 * PI * freq * dt / 1000.0)).toInt().coerceIn(-32768, 32767).toShort() } }
            if (t0 <= cc && cc < t0 + blk * 1000.0 / rate && cc - lastChirp > P / 2) { lastChirp = cc; try { sendEvent("onChirpOut", mapOf("t" to cc)) } catch (_: Throwable) {} }
          }
          if (tr.write(buf, 0, blk) < 0) break; written += blk
        }
      } catch (t: Throwable) { status("audio_error", "speaker: ${t.javaClass.simpleName}: ${t.message}") }
      finally { try { tr?.stop() } catch (_: Throwable) {}; try { tr?.release() } catch (_: Throwable) {} }
    }, "firefly-audio-out").apply { priority = Thread.MAX_PRIORITY; start() }

    inThread = Thread({
      var rec: AudioRecord? = null
      try {
        val am = c.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val src = if (am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true") MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.VOICE_RECOGNITION
        val minB = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        rec = AudioRecord(src, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minB, 4800))
        if (rec.state != AudioRecord.STATE_INITIALIZED) { status("audio_error", "mic init failed"); return@Thread }
        val blk = 240; val buf = ShortArray(blk); var read = 0L; val ts = AudioTimestamp()
        val coeff = 2 * cos(2 * PI * freq / rate); var floor = -1.0; var lastDet = -1e9; var above = false
        rec.startRecording(); status("audio", "audio started src=$src")
        while (audioOn) {
          val n = rec.read(buf, 0, blk); if (n < 0) { status("audio_error", "mic read error $n"); break }; if (n == 0) continue
          var s1 = 0.0; var s2 = 0.0
          for (i in 0 until n) { val s0 = buf[i] + coeff * s1 - s2; s2 = s1; s1 = s0 }
          val pw = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n.toDouble() * n)
          val t0 = if (rec.getTimestamp(ts, AudioTimestamp.TIMEBASE_BOOTTIME) == AudioRecord.SUCCESS) ts.nanoTime / 1e6 + (read - ts.framePosition) * 1000.0 / rate else now() - n * 1000.0 / rate
          read += n
          if (floor < 0) floor = pw
          val ratio = pw / max(floor, 1e-3)
          if (ratio > thrRatio && !above && t0 - lastDet > 200) { lastDet = t0; above = true
            try { sendEvent("onChirp", mapOf("t" to t0, "snr" to 10 * log10(ratio), "rx" to now())) } catch (_: Throwable) {} }
          if (ratio < thrRatio / 3) above = false
          if (ratio < thrRatio) floor = floor * 0.98 + pw * 0.02
        }
      } catch (t: Throwable) { status("audio_error", "mic: ${t.javaClass.simpleName}: ${t.message}") }
      finally { try { rec?.stop() } catch (_: Throwable) {}; try { rec?.release() } catch (_: Throwable) {} }
    }, "firefly-audio-in").apply { priority = Thread.MAX_PRIORITY; start() }
    return "ok"
  }
  private fun stopAudio() { audioOn = false; try { outThread?.join(300); inThread?.join(300) } catch (_: Throwable) {}; outThread = null; inThread = null }

  private fun readCrash(): String { return try { val c = ctxOrNull ?: return ""; val f = crashFile(c); if (f.exists()) f.readText() else "" } catch (_: Throwable) { "" } }
  private fun guard(where: String, block: () -> String): String = try { block() } catch (t: Throwable) { status("native_error", "$where: ${t.javaClass.simpleName}: ${t.message}"); "error: ${t.javaClass.simpleName}: ${t.message}" }

  override fun definition() = ModuleDefinition {
    Name("FireflyNative")
    Events("onAdv", "onStatus", "onChirp", "onChirpOut", "onBtState")
    OnCreate { try { installCrashLogger(); registerBtReceiver() } catch (_: Throwable) {} }
    Function("nowMs") { now() }
    Function("setSchedule") { next: Double, period: Double, fl: Int -> if (next.isFinite()) nextAt = next; if (period.isFinite() && period > 0) periodMs = period; flags = fl and 255 }
    Function("startBle") { id: Double, intervalMs: Int -> guard("startBle") { startBle(id, intervalMs) } }
    Function("stopBle") { guard("stopBle") { stopBle(); "ok" } }
    Function("btState") { try { btState() } catch (t: Throwable) { mapOf("ok" to false, "reason" to (t.message ?: "error")) } }
    Function("bleStats") { mapOf("advUpdates" to advUpdates, "advErrors" to advErrors, "rx" to rxCount, "applyLatMs" to applyLatMs, "advMode" to advMode) }
    Function("startAudio") { f: Double, cm: Double, thr: Double -> guard("startAudio") { startAudio(f, cm, thr) } }
    Function("stopAudio") { guard("stopAudio") { stopAudio(); "ok" } }
    Function("openBluetoothSettings") { guard("openBt") { val c = ctxOrNull ?: return@guard "no context"
      c.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); "ok" } }
    Function("getLastCrash") { readCrash() }
    Function("clearLastCrash") { try { ctxOrNull?.let { crashFile(it).delete() } } catch (_: Throwable) {}; true }
    Function("deviceInfo") { "${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE}), Android ${Build.VERSION.RELEASE} SDK ${Build.VERSION.SDK_INT}" }
    OnDestroy { try { stopBle(); stopAudio(); btReceiver?.let { ctxOrNull?.applicationContext?.unregisterReceiver(it) }; btReceiver = null; thread?.quitSafely(); thread = null; handler = null } catch (_: Throwable) {} }
  }
}
