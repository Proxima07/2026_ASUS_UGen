package com.proxima.localassistant.actions

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import org.json.JSONObject

/** Phone notes belong to the user-selected notes App. No private database is a substitute. */
class NotesHandler(private val activity: Activity) {
    fun execute(kind: String, payload: JSONObject, callback: (JSONObject) -> Unit) {
        require(kind in setOf("notes.create_native", "notes.share"))
        val title = payload.getString("title")
        val content = payload.getString("content")
        require(title.length in 1..200 && content.length in 1..16000)
        val note = Intent("com.google.android.gms.actions.CREATE_NOTE").setType("text/plain")
            .putExtra("com.google.android.gms.actions.extra.NAME", title)
            .putExtra("com.google.android.gms.actions.extra.TEXT", content)
        val share = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TEXT, "$title\n\n$content")
        try {
            val create = kind == "notes.create_native" && note.resolveActivity(activity.packageManager) != null
            if (!create && share.resolveActivity(activity.packageManager) == null) {
                callback(ActionDispatcher.receipt("unsupported", "手機沒有支援新增記事或接收文字的 App")); return
            }
            activity.startActivity(if (create) note else Intent.createChooser(share, "選擇手機記事本 App，並確認保存"))
            callback(ActionDispatcher.receipt("handed_off", if (create)
                "已將內容交給手機記事本，請在該 App 確認保存" else
                "已開啟分享介面，請選擇手機記事本並在該 App 確認保存",
                JSONObject().put("target", if (create) "native_note_intent" else "notes_share_chooser")))
        } catch (_: ActivityNotFoundException) {
            callback(ActionDispatcher.receipt("unsupported", "手機沒有可接收這份記事的 App"))
        }
    }
}
