package com.proxima.localassistant.bridge

import android.app.Activity
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.proxima.localassistant.actions.ActionDispatcher
import com.proxima.localassistant.network.ApiException
import com.proxima.localassistant.network.NativeApiClient
import com.proxima.localassistant.permissions.PermissionController
import com.proxima.localassistant.security.ExecutionReceiptStore
import com.proxima.localassistant.ui.NativeConfirmation
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService

class BridgeController(
    private val activity: Activity,
    private val webView: WebView,
    private val api: NativeApiClient,
    private val dispatcher: ActionDispatcher,
    private val receipts: ExecutionReceiptStore,
    private val worker: ExecutorService,
    permissions: PermissionController,
    private val foregroundTrusted: () -> Boolean,
    private val session: (onReady: () -> Unit, onError: (Exception) -> Unit) -> Unit,
    private val logout: (onReady: () -> Unit, onError: (Exception) -> Unit) -> Unit
) {
    private var busy = false
    private val allowedKinds = setOf("contacts.search", "phone.dial", "alarm.create", "timer.create", "calendar.create", "notes.create_native", "notes.share")
    private val recording = NativeRecordingController(activity, permissions, api, worker, foregroundTrusted)
    fun isBusy(): Boolean = busy || recording.isBusy()
    fun cancelRecording(reason: String) = recording.cancelCurrent(reason)
    fun install() {
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            "請更新 Android System WebView 後再使用"
        }
        WebViewCompat.addWebMessageListener(webView, "NativeBridge", setOf(api.origin)) { _, message, sourceOrigin, mainFrame, reply ->
            if (!mainFrame || sourceOrigin.toString().removeSuffix("/") != api.origin) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            if (raw.length > 4096) return@addWebMessageListener
            var id = ""
            try {
                val body = JSONObject(raw)
                id = body.getString("message_id")
                require(id.length in 1..128 && body.optString("protocol_version") == "1")
                when (body.getString("type")) {
                    "hello" -> session({
                        worker.execute {
                            try {
                                val identity = api.me()
                                send(reply, JSONObject().put("protocol_version", "1").put("message_id", id).put("type", "ready")
                                    .put("identity", JSONObject().put("user_id", identity.getString("user_id"))
                                        .put("device_id", identity.getString("device_id")))
                                    .put("device_id", identity.getString("device_id"))
                                    .put("recording", NativeRecordingController.configuration())
                                    .put("capabilities", JSONArray(allowedKinds.toList())).put("uncertain_actions", receipts.uncertainCount()))
                            } catch (error: Exception) { sendError(reply, id, error) }
                        }
                    }, { error -> sendError(reply, id, error) })
                    "recording_start" -> {
                        require(body.length() == 6 && body.getString("purpose") == "command")
                        if (busy) throw ApiException(409, "native_busy", "請先完成當前手機操作，再錄音")
                        recording.start(id, body.getString("expected_user_id"), body.getString("expected_device_id")) { value ->
                            sendRecording(reply, id, value)
                        }
                    }
                    "recording_stop" -> {
                        require(body.length() == 4)
                        val recordingId = body.getString("recording_id")
                        require(Regex("^rec_[a-f0-9]{32}$").matches(recordingId))
                        recording.stop(recordingId) { value -> sendRecording(reply, id, value) }
                    }
                    "recording_cancel" -> {
                        require(body.length() in 4..5)
                        val recordingId = if (body.has("recording_id")) body.getString("recording_id") else null
                        val startId = if (body.has("start_message_id")) body.getString("start_message_id") else null
                        require(recordingId == null || Regex("^rec_[a-f0-9]{32}$").matches(recordingId))
                        require(startId == null || startId.length in 1..128)
                        require(recordingId != null || startId != null)
                        recording.cancel(recordingId, startId) { value -> sendRecording(reply, id, value) }
                    }
                    "execute_action" -> {
                        require(body.length() == 4)
                        val actionId = NativeApiClient.safeId(body.getString("action_id"))
                        if (isBusy()) throw ApiException(409, "native_busy", "另一個操作或錄音尚未完成，請稍候")
                        if (receipts.contains(actionId)) throw ApiException(409, "action_already_attempted", "這個操作已嘗試執行；請先檢查手機與操作狀態，避免重複執行")
                        busy = true
                        loadAndConfirm(actionId, id, reply)
                    }
                    "logout" -> {
                        if (isBusy()) throw ApiException(409, "native_busy", "請先完成或取消當前操作與錄音，再解除配對")
                        require(body.length() == 3)
                        logout({ send(reply, JSONObject().put("protocol_version", "1").put("message_id", id).put("type", "logged_out")) },
                            { error -> sendError(reply, id, error) })
                    }
                    else -> throw ApiException(400, "unknown_bridge_message", "不支援的手機訊息")
                }
            } catch (error: Exception) { sendError(reply, id, error) }
        }
    }
    private fun loadAndConfirm(actionId: String, messageId: String, reply: JavaScriptReplyProxy) {
        worker.execute {
            try {
                val action = api.getAction(actionId)
                require(action.optString("protocol_version", "1") == "1" && action.getString("action_id") == actionId)
                val kind = action.getString("kind")
                require(kind in allowedKinds)
                if (action.getString("state") != "pending_confirmation")
                    throw ApiException(409, "action_not_pending", "這個操作不在待確認狀態，請重新整理")
                val payload = JSONObject(action.getJSONObject("payload").toString())
                if (kind in setOf("notes.create_native", "notes.share") && !payload.has("content")) {
                    val note = api.getNote(payload.getString("note_id"))
                    payload.put("title", note.getString("title")).put("content", note.getString("content"))
                    if (!note.isNull("transcript")) payload.put("transcript", note.getString("transcript"))
                }
                ui {
                    if (!foregroundTrusted()) { finishError(reply, messageId,
                        ApiException(409, "native_view_changed", "已離開這個操作所屬的助理畫面，沒有執行手機操作")); return@ui }
                    NativeConfirmation.show(activity, kind, payload) { confirmed ->
                        if (confirmed && !foregroundTrusted()) finishError(reply, messageId,
                            ApiException(409, "native_view_changed", "操作所屬的登入或畫面已變更，沒有執行手機操作"))
                        else if (!confirmed) cancel(actionId, messageId, reply)
                        else claimAndExecute(actionId, kind, payload, messageId, reply)
                    }
                }
            } catch (error: Exception) { finishError(reply, messageId, error) }
        }
    }
    private fun cancel(actionId: String, messageId: String, reply: JavaScriptReplyProxy) {
        worker.execute {
            try {
                val response = api.cancel(actionId)
                finishResult(reply, messageId, actionId, "cancelled", "已取消操作", response)
            } catch (error: Exception) { finishError(reply, messageId, error) }
        }
    }
    private fun claimAndExecute(actionId: String, kind: String, payload: JSONObject, messageId: String, reply: JavaScriptReplyProxy) {
        worker.execute {
            try {
                // Persist BEFORE the HTTP claim: a timeout could still mean the server claimed it.
                receipts.preparing(actionId)
                val claimed = api.confirm(actionId)
                val token = claimed.getString("execution_token")
                receipts.claimed(actionId, token)
                ui {
                    if (!foregroundTrusted()) { finishError(reply, messageId,
                        ApiException(409, "claim_uncertain", "登入或畫面已變更，手機操作沒有執行；後端確認可能已受理，請檢查狀態，不會自動重試")); return@ui }
                    dispatcher.dispatch(kind, payload) { outcome ->
                        worker.execute {
                            try {
                                val state = outcome.getString("state")
                                val result = outcome.optJSONObject("result") ?: JSONObject()
                                receipts.complete(actionId, state, result)
                                val response = api.result(actionId, token, state, result)
                                receipts.markSynced(actionId)
                                finishResult(reply, messageId, actionId, state, outcome.optString("message", readableState(state)), response)
                            } catch (error: Exception) {
                                finishError(reply, messageId, ApiException(0, "result_not_synced",
                                    "手機操作可能已執行；結果尚未送回中樞。請檢查手機，使用上方「同步」只重送結果，勿重做操作。"))
                            }
                        }
                    }
                }
            } catch (error: Exception) {
                finishError(reply, messageId, ApiException(0, "claim_uncertain",
                    "操作尚未執行或狀態不確定；請檢查手機與後端狀態，再建立新指令。此操作不會自動重試。"))
            }
        }
    }
    fun syncSavedResults(): Pair<Int, Int> {
        var sent = 0
        var failed = 0
        receipts.pendingResults().forEach {
            try {
                val id = it.getString("action_id")
                api.result(id, it.getString("execution_token"), it.getString("state"), it.getJSONObject("result"))
                receipts.markSynced(id)
                sent++
            } catch (_: Exception) { failed++ }
        }
        return Pair(sent, failed)
    }
    private fun finishResult(reply: JavaScriptReplyProxy, messageId: String, actionId: String, state: String, message: String, response: JSONObject) {
        ui {
            busy = false
            send(reply, JSONObject().put("protocol_version", "1").put("type", "action_result")
                .put("message_id", messageId).put("action_id", actionId).put("state", state)
                .put("message", message).put("result", response))
        }
    }
    private fun finishError(reply: JavaScriptReplyProxy, id: String, error: Exception) { ui { busy = false; sendError(reply, id, error) } }
    private fun sendError(reply: JavaScriptReplyProxy, id: String, error: Exception) {
        send(reply, JSONObject().put("protocol_version", "1").put("message_id", id).put("type", "error")
            .put("error", JSONObject().put("code", (error as? ApiException)?.code ?: "native_error")
                .put("message", if (error is ApiException) error.message else "手機操作無法完成，請檢查連線與權限")))
    }
    private fun sendRecording(reply: JavaScriptReplyProxy, id: String, body: JSONObject) {
        send(reply, body.put("protocol_version", "1").put("message_id", id))
    }
    private fun send(reply: JavaScriptReplyProxy, body: JSONObject) { ui { try { reply.postMessage(body.toString()) } catch (_: Exception) {} } }
    private fun ui(block: () -> Unit) { activity.runOnUiThread { if (!activity.isFinishing && !activity.isDestroyed) block() } }
    private fun readableState(state: String): String = when(state) {
        "completed" -> "操作已完成"; "opened" -> "已開啟手機操作畫面，請完成確認"
        "handed_off" -> "已交給手機 App，請完成確認"; "permission_denied" -> "未取得手機權限"
        "cancelled" -> "操作已取消"; "unsupported" -> "手機沒有支援此操作的 App"; else -> "手機操作未完成"
    }
}
