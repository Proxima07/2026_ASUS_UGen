package com.proxima.localassistant.actions

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import com.proxima.localassistant.storage.LocalNotesStore
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Executor

class NotesHandler(private val activity: Activity, private val store: LocalNotesStore, private val worker: Executor) {
    fun execute(kind: String, payload: JSONObject, callback: (JSONObject) -> Unit) {
        when (kind) {
            "notes.search_local" -> {
                val query = payload.getString("query").trim()
                val purpose = payload.optString("purpose", "lookup")
                require(query.length in 1..200 && purpose in setOf("lookup", "update"))
                worker.execute {
                    try {
                        val needle = query.lowercase(Locale.ROOT)
                        val result = JSONObject().put("notes", JSONArray())
                        val notes = result.getJSONArray("notes")
                        for (note in store.list()) {
                            val title = note.getString("title")
                            val content = note.getString("content")
                            if (!(title + "\n" + content).lowercase(Locale.ROOT).contains(needle)) continue
                            val metadata = JSONObject().put("note_id", note.getString("note_id"))
                                .put("title", title).put("preview", content.take(300))
                            notes.put(metadata)
                            // Leave room for Python's JSON whitespace and the outer result envelope.
                            if (result.toString().toByteArray(Charsets.UTF_8).size > 28_000) {
                                notes.remove(notes.length() - 1)
                                break
                            }
                            if (notes.length() == 20) break
                        }
                        callback(ActionDispatcher.receipt("completed", "手機筆記搜尋完成", result))
                    } catch (_: Exception) { callback(ActionDispatcher.receipt("failed", "無法解密或搜尋手機筆記")) }
                }
            }
            "notes.update_local" -> {
                val noteId = payload.getString("note_id")
                val content = payload.getString("content")
                val mode = payload.getString("mode")
                val title = if (!payload.has("title") || payload.isNull("title")) null else payload.getString("title")
                require(noteId.length in 1..100 && content.length in 1..16000)
                require(mode in setOf("replace", "append") && (title == null || title.length in 1..200))
                worker.execute {
                    try {
                        val note = store.update(noteId, content, mode, title)
                        callback(ActionDispatcher.receipt("completed", "已更新這個 App 的加密筆記",
                            JSONObject().put("note_id", note.getString("note_id"))))
                    } catch (_: NoSuchElementException) {
                        callback(ActionDispatcher.receipt("failed", "找不到這筆手機筆記，沒有建立或修改任何筆記"))
                    } catch (_: IllegalArgumentException) {
                        callback(ActionDispatcher.receipt("failed", "更新後的筆記超過 16000 字元，沒有修改"))
                    } catch (_: Exception) { callback(ActionDispatcher.receipt("failed", "手機筆記沒有完成更新，請先檢查本機筆記")) }
                }
            }
            "notes.save_local" -> {
                validateFullNote(payload)
                worker.execute {
                    try {
                        val note = store.save(payload)
                        callback(ActionDispatcher.receipt("completed", "已保存到這個 App 的加密筆記",
                            JSONObject().put("note_id", note.getString("note_id"))))
                    } catch (_: Exception) { callback(ActionDispatcher.receipt("failed", "手機筆記沒有完成加密保存")) }
                }
            }
            "notes.share" -> {
                validateFullNote(payload)
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

    private fun validateFullNote(payload: JSONObject) {
        require(payload.getString("note_id").length in 1..100)
        require(payload.getString("title").length in 1..200)
        require(payload.getString("content").length in 1..16000)
    }
}
