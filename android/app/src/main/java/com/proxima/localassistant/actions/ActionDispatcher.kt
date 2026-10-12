package com.proxima.localassistant.actions

import android.app.Activity
import android.os.Handler
import android.os.Looper
import com.proxima.localassistant.permissions.PermissionController
import com.proxima.localassistant.storage.LocalNotesStore
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/** Fixed capability list: never accepts an Intent, URI, class name or executable from the model. */
class ActionDispatcher(
    private val activity: Activity,
    private val permissions: PermissionController,
    private val notes: LocalNotesStore,
    private val worker: Executor = DEFAULT_WORKER
) {
    fun dispatch(kind: String, payload: JSONObject, callback: (JSONObject) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        val reply: (JSONObject) -> Unit = { result ->
            if (Looper.myLooper() == Looper.getMainLooper()) callback(result)
            else main.post { callback(result) }
        }
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { dispatch(kind, payload, callback) }
            return
        }
        try {
            when (kind) {
                "contacts.search" -> ContactsHandler(activity, permissions, worker).execute(payload, reply)
                "phone.dial" -> DialHandler(activity).execute(payload, reply)
                "alarm.create" -> AlarmHandler(activity).execute(payload, reply)
                "calendar.create" -> CalendarHandler(activity, permissions, worker).execute(payload, reply)
                "notes.save_local", "notes.share" -> NotesHandler(activity, notes, worker).execute(kind, payload, reply)
                else -> reply(receipt("unsupported", "手機不支援這項操作"))
            }
        } catch (_: SecurityException) {
            reply(receipt("permission_denied", "未取得這項手機操作所需的權限"))
        } catch (_: Exception) {
            reply(receipt("failed", "操作參數或手機功能無法處理，請重新檢查"))
        }
    }

    companion object {
        private val DEFAULT_WORKER = Executors.newSingleThreadExecutor()
        fun receipt(state: String, message: String, result: JSONObject = JSONObject()): JSONObject =
            JSONObject().put("state", state).put("message", message).put("result", result)
    }
}
