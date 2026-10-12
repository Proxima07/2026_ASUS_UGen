package com.proxima.localassistant.actions

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import com.proxima.localassistant.storage.LocalNotesStore
import org.json.JSONObject
import java.util.concurrent.Executor

class NotesHandler(private val activity: Activity, private val store: LocalNotesStore, private val worker: Executor) {
    fun execute(kind: String, payload: JSONObject, callback: (JSONObject) -> Unit) {
        require(payload.getString("note_id").length in 1..100)
        require(payload.getString("title").length in 1..200)
        require(payload.getString("content").length in 1..16000)
        when (kind) {
            "notes.save_local" -> worker.execute {
                try {
                    val note = store.save(payload)
                    callback(ActionDispatcher.receipt("completed", "已保存到這個 App 的加密筆記",
                        JSONObject().put("note_id", note.getString("note_id"))))
                } catch (_: Exception) { callback(ActionDispatcher.receipt("failed", "手機筆記沒有完成加密保存")) }
            }
            "notes.share" -> {
                val intent = Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, payload.getString("title"))
                    .putExtra(Intent.EXTRA_TEXT, "${payload.getString("title")}\n\n${payload.getString("content")}")
                try {
                    activity.startActivity(Intent.createChooser(intent, "分享筆記到"))
                    callback(ActionDispatcher.receipt("handed_off", "已開啟分享介面，請在接收 App 確認保存",
                        JSONObject().put("note_id", payload.getString("note_id"))))
                } catch (_: ActivityNotFoundException) { callback(ActionDispatcher.receipt("unsupported", "這支手機沒有可接收文字的 App")) }
            }
            else -> callback(ActionDispatcher.receipt("unsupported", "不支援的筆記操作"))
        }
    }
}
