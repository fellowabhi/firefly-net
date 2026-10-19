package expo.modules.fireflynative

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.*
import android.content.Context
import android.media.*
import android.os.*
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.*

// Firefly Net native side.
// Clock: everything is SystemClock.elapsedRealtime in ms (double). BLE ScanResult.timestampNanos and
// AudioTimestamp TIMEBASE_BOOTTIME are on the same clock, so JS event delivery delay does not matter.
class FireflyNativeModule : Module() {
  private val ctx: Context get() = appContext.reactContext ?: throw IllegalStateException("no context")
  private val thread = HandlerThread("firefly-ble").apply { start() }
  private val handler = Handler(thread.looper)
  private fun now() = SystemClock.elapsedRealtimeNanos() / 1e6

  // schedule shared by BLE + audio: next planned light (ms, elapsedRealtime) and period
  @Volatile private var nextAt = 0.0
  @Volatile private var periodMs = 1000.0
  @Volatile private var flags = 0

  // ---------------- BLE ----------------
  private val COMPANY = 0xFFFF
  private var myId = 0L
  private var seq = 0
  private var advSet: AdvertisingSet? = null
  private var advCb: AdvertisingSetCallback? = null
  private var scanCb: ScanCallback? = null
  private var updateMs = 100L
  private var advUpdates = 0; private var advErrors = 0; private var rxCount = 0
  private var lastSetCall = 0.0; @Volatile private var applyLatMs = 0.0
  private var bleOn = false

  private fun ttf(t: Double): Int { var d = (nextAt - t) % periodMs; if (d < 0) d += periodMs; return d.roundToInt().coerceIn(0, 65535) }
  private fun payload(): ByteArray {
    val t = ttf(now() + applyLatMs) // value valid when the controller actually starts sending it
    val p = periodMs.roundToInt(); val id = myId
    seq = (seq + 1) and 255
    return byteArrayOf(0x46, 0x03, (id and 255).toByte(), ((id shr 8) and 255).toByte(), ((id shr 16) and 255).toByte(), ((id shr 24) and 255).toByte(),
      seq.toByte(), (t and 255).toByte(), (t shr 8).toByte(), (p and 255).toByte(), (p shr 8).toByte(), flags.toByte())
  }
  private fun advData() = AdvertiseData.Builder().setIncludeDeviceName(false).setIncludeTxPowerLevel(false).addManufacturerData(COMPANY, payload()).build()

  private val updater = object : Runnable {
    @SuppressLint("MissingPermission")
    override fun run() {
      val s = advSet
      if (s != null && bleOn) { try { lastSetCall = now(); s.setAdvertisingData(advData()) } catch (e: Exception) { advErrors++ } }
      if (bleOn) handler.postDelayed(this, updateMs)
    }
  }

  private fun status(kind: String, msg: String) = sendEvent("onStatus", mapOf("kind" to kind, "msg" to msg, "t" to now()))

  @SuppressLint("MissingPermission")
  private fun startBle(id: Double, intervalMs: Int): String {
    val bm = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    val ad = bm.adapter ?: return "no bluetooth adapter"
    if (!ad.isEnabled) return "bluetooth is off"
    stopBle()
    myId = id.toLong() and 0xFFFFFFFFL; updateMs = intervalMs.toLong().coerceAtLeast(50); bleOn = true
    // advertiser: legacy, non-connectable, 100 ms interval, high power; data updated in place every updateMs
    val adv = ad.bluetoothLeAdvertiser ?: return "BLE advertising not supported on this phone"
    val params = AdvertisingSetParameters.Builder().setLegacyMode(true).setConnectable(false).setScannable(false)
      .setInterval(AdvertisingSetParameters.INTERVAL_MIN).setTxPowerLevel(AdvertisingSetParameters.TX_POWER_HIGH).build()
    val cb = object : AdvertisingSetCallback() {
      override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, st: Int) {
        if (st == ADVERTISE_SUCCESS && set != null) { advSet = set; status("adv", "advertising started tx=$txPower"); handler.post(updater) }
        else status("adv_error", "advertising failed code=$st")
      }
      override fun onAdvertisingDataSet(set: AdvertisingSet?, st: Int) {
        if (st == ADVERTISE_SUCCESS) { advUpdates++; val l = now() - lastSetCall; applyLatMs = if (applyLatMs == 0.0) l else applyLatMs * 0.9 + l * 0.1 } else advErrors++
      }
    }
    advCb = cb
    try { adv.startAdvertisingSet(params, advData(), null, null, null, cb) } catch (e: Exception) { return "advertise error: ${e.message}" }
    // scanner: low latency, every packet, our manufacturer id + magic only
    val sc = ad.bluetoothLeScanner ?: return "BLE scanning not supported"
    val filter = ScanFilter.Builder().setManufacturerData(COMPANY, byteArrayOf(0x46, 0x03), byteArrayOf(-1, -1)).build()
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
      .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE).setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT).setReportDelay(0).setLegacy(true).build()
    val scb = object : ScanCallback() {
      override fun onScanResult(type: Int, r: ScanResult) = handle(r)
      override fun onBatchScanResults(rs: MutableList<ScanResult>) { rs.forEach { handle(it) } }
      override fun onScanFailed(code: Int) { status("scan_error", "scan failed code=$code") }
    }
    scanCb = scb
    try { sc.startScan(listOf(filter), settings, scb) } catch (e: Exception) { return "scan error: ${e.message}" }
    return "ok"
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
    bleOn = false; handler.removeCallbacks(updater)
    try {
      val bm = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
      advCb?.let { bm.adapter?.bluetoothLeAdvertiser?.stopAdvertisingSet(it) }
      scanCb?.let { bm.adapter?.bluetoothLeScanner?.stopScan(it) }
    } catch (_: Exception) {}
    advCb = null; scanCb = null; advSet = null
  }

  // ---------------- AUDIO (experimental) ----------------
  // Out: continuous AudioTrack stream of silence; a short Hann-windowed tone is mixed in so that it is
  // PRESENTED (AudioTrack.getTimestamp) exactly at each planned light time. In: AudioRecord, Goertzel
  // power at the tone frequency per 5 ms block; onset time from AudioRecord.getTimestamp (BOOTTIME).
  @Volatile private var audioOn = false
  private var outThread: Thread? = null; private var inThread: Thread? = null
  @Volatile private var freq = 18000.0; @Volatile private var chirpMs = 30.0; @Volatile private var thrRatio = 12.0

  @SuppressLint("MissingPermission")
  private fun startAudio(f: Double, cm: Double, thr: Double): String {
    stopAudio(); freq = f; chirpMs = cm; thrRatio = thr; audioOn = true
    val rate = 48000
    outThread = Thread({
      val minB = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
      val tr = AudioTrack.Builder()
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setBufferSizeInBytes(max(minB, 4 * 480)).setTransferMode(AudioTrack.MODE_STREAM)
        .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY).build()
      val blk = 240; val buf = ShortArray(blk); var written = 0L; val ts = AudioTimestamp(); var lastChirp = -1e9
      tr.play()
      try {
        while (audioOn) {
          // presentation time (elapsedRealtime ms) of the first frame of this block
          val monoToBoot = (SystemClock.elapsedRealtimeNanos() - System.nanoTime()) / 1e6
          val t0 = if (tr.getTimestamp(ts)) ts.nanoTime / 1e6 + monoToBoot + (written - ts.framePosition) * 1000.0 / rate
                   else now() + (written - tr.playbackHeadPosition.toLong()) * 1000.0 / rate
          val P = periodMs; var c = nextAt; if (P > 0) { val k = floor((t0 - c) / P); c += k * P } // grid point at/before t0
          java.util.Arrays.fill(buf, 0.toShort())
          for (cc in doubleArrayOf(c, c + P)) {
            for (i in 0 until blk) { val dt = t0 + i * 1000.0 / rate - cc
              if (dt >= 0 && dt < chirpMs) { val w = 0.5 - 0.5 * cos(2 * PI * dt / chirpMs); buf[i] = (buf[i] + 26000 * w * sin(2 * PI * freq * dt / 1000.0)).toInt().toShort() } }
            if (t0 <= cc && cc < t0 + blk * 1000.0 / rate && cc - lastChirp > P / 2) { lastChirp = cc; sendEvent("onChirpOut", mapOf("t" to cc)) }
          }
          tr.write(buf, 0, blk); written += blk
        }
      } finally { tr.stop(); tr.release() }
    }, "firefly-audio-out").apply { priority = Thread.MAX_PRIORITY; start() }

    inThread = Thread({
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val src = if (am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true") MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.VOICE_RECOGNITION
      val minB = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      val rec = try { AudioRecord(src, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minB, 4800)) } catch (e: Exception) { status("audio_error", "mic: ${e.message}"); return@Thread }
      if (rec.state != AudioRecord.STATE_INITIALIZED) { status("audio_error", "mic init failed"); return@Thread }
      val blk = 240; val buf = ShortArray(blk); var read = 0L; val ts = AudioTimestamp()
      val coeff = 2 * cos(2 * PI * freq / rate); var floor = -1.0; var lastDet = -1e9; var above = false
      rec.startRecording(); status("audio", "audio started src=$src")
      try {
        while (audioOn) {
          val n = rec.read(buf, 0, blk); if (n <= 0) continue
          var s1 = 0.0; var s2 = 0.0
          for (i in 0 until n) { val s0 = buf[i] + coeff * s1 - s2; s2 = s1; s1 = s0 }
          val pw = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n)
          val t0 = if (rec.getTimestamp(ts, AudioTimestamp.TIMEBASE_BOOTTIME) == AudioRecord.SUCCESS) ts.nanoTime / 1e6 + (read - ts.framePosition) * 1000.0 / rate
                   else now() - n * 1000.0 / rate
          read += n
          if (floor < 0) floor = pw
          val ratio = pw / max(floor, 1e-3)
          if (ratio > thrRatio && !above && t0 - lastDet > 200) { lastDet = t0; above = true
            sendEvent("onChirp", mapOf("t" to t0, "snr" to 10 * log10(ratio), "rx" to now())) }
          if (ratio < thrRatio / 3) above = false
          if (ratio < thrRatio) floor = floor * 0.98 + pw * 0.02
        }
      } finally { rec.stop(); rec.release() }
    }, "firefly-audio-in").apply { priority = Thread.MAX_PRIORITY; start() }
    return "ok"
  }
  private fun stopAudio() { audioOn = false; outThread?.join(300); inThread?.join(300); outThread = null; inThread = null }

  override fun definition() = ModuleDefinition {
    Name("FireflyNative")
    Events("onAdv", "onStatus", "onChirp", "onChirpOut")
    Function("nowMs") { now() }
    Function("setSchedule") { next: Double, period: Double, fl: Int -> nextAt = next; periodMs = period; flags = fl }
    Function("startBle") { id: Double, intervalMs: Int -> startBle(id, intervalMs) }
    Function("stopBle") { stopBle() }
    Function("bleStats") { mapOf("advUpdates" to advUpdates, "advErrors" to advErrors, "rx" to rxCount, "applyLatMs" to applyLatMs) }
    Function("startAudio") { f: Double, cm: Double, thr: Double -> startAudio(f, cm, thr) }
    Function("stopAudio") { stopAudio() }
    OnDestroy { stopBle(); stopAudio(); thread.quitSafely() }
  }
}
