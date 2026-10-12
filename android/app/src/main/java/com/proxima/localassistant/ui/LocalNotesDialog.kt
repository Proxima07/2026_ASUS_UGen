package com.proxima.localassistant.ui

import android.app.Activity
import android.app.AlertDialog
import android.widget.ScrollView
import android.widget.TextView
import com.proxima.localassistant.storage.LocalNotesStore
import java.util.concurrent.Executor

/** Shows only notes explicitly saved to this APK; no network is required. */
object LocalNotesDialog {
    fun show(activity: Activity, store: LocalNotesStore, worker: Executor) {
        worker.execute {
            try {
                val notes = store.list()
                activity.runOnUiThread {
                    if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                    if (notes.isEmpty()) {
                        AlertDialog.Builder(activity).setTitle("手機加密筆記")
                            .setMessage("尚無筆記。請在網頁筆記卡片選擇保存到手機。")
                            .setPositiveButton("知道了", null).show()
                    } else AlertDialog.Builder(activity).setTitle("手機加密筆記")
                        .setItems(notes.map { it.getString("title") }.toTypedArray()) { _, index ->
                            val note = notes[index]
                            val text = TextView(activity).apply {
                                this.text = "${note.getString("title")}\n\n${note.getString("content")}" +
                                    (if (note.has("transcript")) "\n\n逐字稿\n${note.getString("transcript")}" else "")
                                textSize = 16f
                                val padding = (20 * activity.resources.displayMetrics.density).toInt()
                                setPadding(padding, padding, padding, padding)
                                setTextIsSelectable(true)
                            }
                            val scroll = ScrollView(activity).apply { addView(text) }
                            AlertDialog.Builder(activity).setTitle("筆記內容").setView(scroll)
                                .setPositiveButton("關閉", null).show()
                        }.setNegativeButton("關閉", null).show()
                }
            } catch (_: Exception) {
                activity.runOnUiThread {
                    if (!activity.isFinishing && !activity.isDestroyed) AlertDialog.Builder(activity)
                        .setTitle("手機加密筆記").setMessage("無法解密筆記。請確認 App 資料及 Android Keystore 金鑰仍在此裝置。")
                        .setPositiveButton("關閉", null).show()
                }
            }
        }
    }
}
