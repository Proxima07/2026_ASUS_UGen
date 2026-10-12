package com.proxima.localassistant.ui

import android.app.Activity
import android.app.AlertDialog
import android.widget.ScrollView
import android.widget.TextView
import com.proxima.localassistant.actions.TimerHandler
import org.json.JSONObject
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/** Native confirmation uses actual server-fetched parameters, never a web supplied summary. */
object NativeConfirmation {
    fun show(activity: Activity, kind: String, payload: JSONObject, callback: (Boolean) -> Unit) {
        showDetailed(activity, kind, payload, "", callback)
    }

    fun showDetailed(activity: Activity, kind: String, payload: JSONObject, additionalDetails: String,
                     callback: (Boolean) -> Unit) {
        if (activity.isFinishing || activity.isDestroyed) { callback(false); return }
        val details = try { describe(kind, payload) } catch (_: Exception) {
            callback(false); return
        }
        val density = activity.resources.displayMetrics.density
        val text = TextView(activity).apply {
            this.text = if (additionalDetails.isBlank()) details else "$additionalDetails\n\n$details"
            textSize = 16f
            setPadding((24 * density).toInt(), (12 * density).toInt(), (24 * density).toInt(), (12 * density).toInt())
            setTextIsSelectable(true)
        }
        val scroll = ScrollView(activity).apply { addView(text) }
        val answered = AtomicBoolean(false)
        fun answer(value: Boolean) { if (answered.compareAndSet(false, true)) callback(value) }
        AlertDialog.Builder(activity).setTitle("確認手機操作").setView(scroll)
            .setPositiveButton("確認") { _, _ -> answer(true) }
            .setNegativeButton("取消") { _, _ -> answer(false) }
            .setOnCancelListener { answer(false) }.show()
    }

    fun describe(kind: String, payload: JSONObject): String = when (kind) {
        "contacts.search" -> "搜尋手機通訊錄：${payload.getString("query")}\n只將符合的最多 20 筆姓名與號碼傳回已配對中樞。"
        "phone.dial" -> "聯絡人：${payload.optString("name").ifBlank { "未指定" }}\n電話：${payload.getString("phone_number")}\n開啟撥號畫面後，由你按下通話。"
        "alarm.create" -> {
            val days = payload.optJSONArray("weekdays")
            val names = arrayOf("", "週日", "週一", "週二", "週三", "週四", "週五", "週六")
            val repeat = if (days == null || days.length() == 0) "不重複（下一個符合時間）"
                else (0 until days.length()).joinToString("、") { names[days.getInt(it)] }
            "鬧鐘：${String.format(Locale.ROOT, "%02d:%02d", payload.getInt("hour"), payload.getInt("minute"))}\n名稱：${payload.optString("label", "提醒")}\n重複：$repeat\n使用手機目前時區。請在時鐘 App 確認鬧鐘已建立。"
        }
        "timer.create" -> {
            val duration = payload.getInt("duration_seconds")
            val label = payload.optString("label", "倒數計時")
            require(label.length <= 200)
            "倒數計時 ${TimerHandler.formatDuration(duration)}\n名稱：$label\n將開啟手機時鐘的計時器介面。請在時鐘 App 確認是否已開始計時。"
        }
        "calendar.create" -> {
            val defaultsNotice = if (!payload.has("defaults_notice") || payload.isNull("defaults_notice")) ""
                else payload.getString("defaults_notice").take(500)
            val defaultsDetails = if (defaultsNotice.isBlank()) "" else "\n\n預設設定：$defaultsNotice"
            "事件：${payload.getString("title")}\n開始：${formatDate(payload.getString("start"))}\n結束：${formatDate(payload.getString("end"))}\n地點：${payload.optString("location")}\n提醒：開始前 ${payload.optInt("reminder_minutes", 10)} 分鐘\n說明：${payload.optString("description")}$defaultsDetails"
        }
        "notes.save_local" -> "保存到這個 App 的加密筆記\n\n${payload.getString("title")}\n\n${payload.getString("content")}"
        "notes.search_local" -> {
            val purpose = payload.optString("purpose", "lookup")
            require(purpose in setOf("lookup", "update"))
            "搜尋這個 App 的加密筆記：${payload.getString("query")}\n用途：${if (purpose == "update") "找出要修改的筆記" else "查詢筆記"}\n只將最多 20 筆筆記的識別碼、標題與前 300 字元摘要傳回已配對中樞。完整筆記仍保留在手機。"
        }
        "notes.update_local" -> {
            val mode = payload.getString("mode")
            require(mode in setOf("replace", "append"))
            val currentTitle = if (!payload.has("current_title") || payload.isNull("current_title")) ""
                else payload.getString("current_title").take(200)
            val currentPreview = if (!payload.has("current_preview") || payload.isNull("current_preview")) ""
                else payload.getString("current_preview").take(300)
            val target = if (currentTitle.isBlank()) "筆記識別碼：${payload.getString("note_id")}" else "要修改的筆記：$currentTitle"
            val preview = if (currentPreview.isBlank()) "" else "\n目前內容（預覽）：\n$currentPreview\n"
            val rename = if (!payload.has("title") || payload.isNull("title")) "標題：維持原標題"
                else "新標題：${payload.getString("title")}"
            "修改這個 App 的加密筆記\n$target$preview\n$rename\n方式：${if (mode == "append") "在原內容後換行追加" else "以以下內容取代原內容"}\n\n${payload.getString("content")}\n\n只修改既有筆記；若找不到，不會建立新筆記。"
        }
        "notes.share" -> "把以下內容交給你選擇的 App：\n\n${payload.getString("title")}\n\n${payload.getString("content")}\n\n接收 App 是否保存，需由你在該 App 確認。"
        else -> throw IllegalArgumentException("Unsupported action")
    }

    private fun formatDate(value: String): String {
        val parsed = OffsetDateTime.parse(value)
        val local = parsed.atZoneSameInstant(ZoneId.systemDefault())
        val format = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm XXX", Locale.TAIWAN)
        return "${format.format(local)}（手機時區 ${local.zone.id}；原始 $value）"
    }
}
