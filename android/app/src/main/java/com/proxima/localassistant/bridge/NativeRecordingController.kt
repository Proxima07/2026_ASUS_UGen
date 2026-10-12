package com.proxima.localassistant.bridge

import android.Manifest
import android.app.Activity
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.proxima.localassistant.network.ApiException
import com.proxima.localassistant.network.NativeApiClient
import com.proxima.localassistant.permissions.PermissionController
import okhttp3.Call
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ExecutorService

/** Native microphone -> private temporary M4A -> one authenticated HTTPS file upload. */
class NativeRecordingController(
    private val activity: Activity,
    private val permissions: PermissionController,
    private val api: NativeApiClient,
    private val worker: ExecutorService,
    private val foregroundTrusted: () -> Boolean
) {
    companion object {
        const val MAX_DURATION_MS = 180_000
        const val MAX_BYTES = 8_388_608L
        fun configuration(): JSONObject = JSONObject().put("protocol_version", "1").put("format", "audio/mp4")
            .put("max_duration_ms", MAX_DURATION_MS).put("max_bytes", MAX_BYTES)
    }
    private class Session(val startMessageId: String, val emitStart: (JSONObject) -> Unit) {
        val id = "rec_" + UUID.randomUUID().toString().replace("-", "")
        var recorder: MediaRecorder? = null
        var file: File? = null
        var startedAt = 0L
        var phase = "requesting"
        var tick: Runnable? = null
        var startupDeadline: Runnable? = null
        @Volatile var cancelled = false
        @Volatile var identityCall: Call? = null
        @Volatile var upload: Call? = null
    }
    private val main = Handler(Looper.getMainLooper())
    private val directory = File(activity.cacheDir, "pending_voice")
    private var active: Session? = null

    init {
        directory.mkdirs()
        // A process killed before cleanup leaves only unclaimed temporary audio, never a reusable recording.
        directory.listFiles()?.filter { it.isFile && it.name.endsWith(".m4a") }?.forEach { it.delete() }
    }
    fun isBusy(): Boolean = active != null
    fun start(messageId: String, expectedUser: String, expectedDevice: String, emit: (JSONObject) -> Unit) {
        checkMain()
        if (active != null) throw ApiException(409, "native_recording_busy", "另一段錄音尚未結束")
        require(expectedUser.length in 1..200 && Regex("^dev_[a-f0-9]{32}$").matches(expectedDevice))
        if (!foregroundTrusted()) throw ApiException(403, "recording_not_foreground", "請回到已配對的助理畫面再錄音")
        val session = Session(messageId, emit)
        active = session
        val deadline = Runnable {
            if (current(session) && session.phase == "requesting") fail(session,
                ApiException(0, "microphone_start_timeout", "麥克風啟動超時，已取消等待。請允許錄音權限並重新開始"))
        }
        session.startupDeadline = deadline
        main.postDelayed(deadline, 15_000)
        worker.execute {
            try {
                if (session.cancelled) return@execute
                val lookup = api.identityCall()
                session.identityCall = lookup
                if (session.cancelled) { lookup.cancel(); return@execute }
                val identity = api.executeIdentity(lookup)
                if (identity.optString("user_id") != expectedUser || identity.optString("device_id") != expectedDevice)
                    throw ApiException(409, "recording_identity_mismatch", "網頁與 APK 登入身分不同，請重新開啟已配對助理")
                main.post {
                    if (!current(session)) return@post
                    if (!foregroundTrusted()) { cancelCurrent("background"); return@post }
                    permissions.request(arrayOf(Manifest.permission.RECORD_AUDIO)) { granted ->
                        if (!current(session)) return@request
                        if (!granted) { fail(session, ApiException(403, "microphone_permission_denied", "未允許麥克風，請在手機設定允許本地助理錄音")); return@request }
                        if (!foregroundTrusted()) { cancelCurrent("background"); return@request }
                        beginRecording(session)
                    }
                }
            } catch (error: Exception) { main.post { if (current(session)) fail(session, error) } }
            finally { session.identityCall = null }
        }
    }
    @Suppress("DEPRECATION")
    private fun beginRecording(session: Session) {
        try {
            val file = File(directory, session.id + ".m4a")
            session.file = file
            val recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(activity) else MediaRecorder()
            session.recorder = recorder
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioEncodingBitRate(96_000)
            recorder.setAudioSamplingRate(44_100)
            recorder.setMaxDuration(MAX_DURATION_MS)
            recorder.setMaxFileSize(MAX_BYTES)
            recorder.setOutputFile(file.absolutePath)
            recorder.setOnErrorListener { _, _, _ -> if (current(session)) fail(session,
                ApiException(0, "native_recording_failed", "手機錄音中斷，音訊已捨棄，請檢查麥克風或其他錄音 App")) }
            recorder.setOnInfoListener { _, info, _ ->
                if (current(session) && session.phase == "recording" && info in setOf(
                        MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED,
                        MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)) cancelCurrent("limit")
            }
            recorder.prepare()
            recorder.start()
            session.startupDeadline?.let { main.removeCallbacks(it) }; session.startupDeadline = null
            session.phase = "recording"
            session.startedAt = SystemClock.elapsedRealtime()
            session.emitStart(event("recording_started", session).put("format", "audio/mp4"))
            val tick = object : Runnable {
                override fun run() {
                    if (!current(session) || session.phase != "recording") return
                    if (!foregroundTrusted()) { cancelCurrent("background"); return }
                    val elapsed = SystemClock.elapsedRealtime() - session.startedAt
                    if (elapsed >= MAX_DURATION_MS) { cancelCurrent("limit"); return }
                    val amplitude = runCatching { recorder.maxAmplitude }.getOrDefault(0)
                    session.emitStart(event("recording_progress", session).put("elapsed_ms", elapsed)
                        .put("level", (amplitude / 32767.0).coerceIn(0.0, 1.0)))
                    main.postDelayed(this, 250)
                }
            }
            session.tick = tick
            main.post(tick)
        } catch (_: Exception) {
            fail(session, ApiException(0, "native_recording_start_failed", "手機無法開始錄音。請檢查麥克風權限、系統麥克風開關及其他錄音 App"))
        }
    }
    fun stop(recordingId: String, emit: (JSONObject) -> Unit) {
        checkMain()
        val session = active ?: throw ApiException(409, "recording_not_active", "目前沒有可結束的手機錄音")
        if (session.id != recordingId || session.phase != "recording")
            throw ApiException(409, "recording_not_active", "這段錄音不在收聽狀態")
        if (!foregroundTrusted()) { cancelCurrent("background"); throw ApiException(403, "recording_not_foreground", "錄音已取消，請回到助理畫面") }
        session.phase = "stopping"
        emit(event("recording_stopping", session))
        val stopped = releaseRecorder(session, true)
        if (!stopped || (session.file?.length() ?: 0L) !in 1..MAX_BYTES) {
            fail(session, ApiException(0, "recording_empty", "錄音太短或沒有完整音訊，請重新錄音"), emit); return
        }
        session.phase = "uploading"
        emit(event("recording_uploading", session))
        worker.execute {
            try {
                if (session.cancelled) return@execute
                val upload = api.commandAudioUpload(session.file!!)
                session.upload = upload
                if (session.cancelled) { upload.cancel(); return@execute }
                val job = api.executeAudioUpload(upload)
                require(Regex("^job_[a-f0-9]{32}$").matches(job.optString("job_id")) && job.optString("status") == "queued" &&
                    Regex("^http_[a-f0-9]{32}$").matches(job.optString("trace_id")))
                main.post {
                    if (!current(session)) return@post
                    if (!foregroundTrusted()) { cancelCurrent("background"); return@post }
                    active = null
                    emit(event("recording_uploaded", session).put("job_id", job.getString("job_id"))
                        .put("trace_id", job.optString("trace_id")).put("status", job.optString("status", "queued"))
                        .put("purpose", "command"))
                }
            } catch (error: Exception) {
                main.post { if (current(session)) fail(session, ApiException((error as? ApiException)?.status ?: 0,
                    (error as? ApiException)?.code ?: "audio_upload_uncertain",
                    "錄音上傳沒有完成確認。後端可能已收到音訊；不會自動重送。請檢查連線與後端日誌，再開始新的錄音。"), emit) }
            } finally {
                session.upload = null
                session.file?.delete()
            }
        }
    }
    fun cancel(recordingId: String?, startMessageId: String?, emit: (JSONObject) -> Unit) {
        checkMain()
        val session = active
        if (session == null) { emit(JSONObject().put("type", "recording_cancelled").put("reason", "not_active")); return }
        val matches = recordingId != null && recordingId == session.id ||
            recordingId == null && startMessageId != null && startMessageId == session.startMessageId
        if (!matches) throw ApiException(409, "recording_identity_mismatch", "取消訊息與當前錄音不符")
        val response = event("recording_cancelled", session).put("reason", "user")
        cancelCurrent("user")
        emit(response)
    }
    fun cancelCurrent(reason: String) {
        checkMain()
        val session = active ?: return
        session.cancelled = true
        active = null
        releaseRecorder(session, session.phase == "recording")
        session.identityCall?.cancel()
        session.upload?.cancel()
        // Upload worker owns an open file while sending; its finally deletes after cancellation.
        if (session.phase != "uploading") session.file?.delete()
        session.emitStart(event("recording_cancelled", session).put("reason", reason))
    }
    private fun fail(session: Session, error: Exception, emit: (JSONObject) -> Unit = session.emitStart) {
        if (!current(session)) return
        session.cancelled = true
        active = null
        releaseRecorder(session, session.phase == "recording")
        session.identityCall?.cancel()
        session.upload?.cancel()
        if (session.phase != "uploading") session.file?.delete()
        emit(event("error", session).put("error", JSONObject()
            .put("code", (error as? ApiException)?.code ?: "native_recording_failed")
            .put("message", (error as? ApiException)?.message ?: "手機錄音沒有完成，請重新確認麥克風與連線")))
    }
    private fun releaseRecorder(session: Session, stop: Boolean): Boolean {
        session.tick?.let { main.removeCallbacks(it) }; session.tick = null
        session.startupDeadline?.let { main.removeCallbacks(it) }; session.startupDeadline = null
        val recorder = session.recorder ?: return !stop
        session.recorder = null
        var success = true
        try { if (stop) recorder.stop() } catch (_: Exception) { success = false }
        finally { runCatching { recorder.reset() }; runCatching { recorder.release() } }
        return success
    }
    private fun current(session: Session): Boolean = active === session && !session.cancelled
    private fun event(type: String, session: Session) = JSONObject().put("type", type).put("recording_id", session.id)
    private fun checkMain() = check(Looper.myLooper() == Looper.getMainLooper())
}
