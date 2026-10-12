package com.proxima.localassistant.actions

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentProviderOperation
import android.content.ContentValues
import android.provider.CalendarContract
import com.proxima.localassistant.permissions.PermissionController
import com.proxima.localassistant.ui.NativeConfirmation
import org.json.JSONObject
import java.time.OffsetDateTime
import java.util.TimeZone
import java.util.concurrent.Executor

/** Inserts an event + reminder atomically into a user-selected existing writable calendar. */
class CalendarHandler(
    private val activity: Activity,
    private val permissions: PermissionController,
    private val worker: Executor
) {
    private data class Destination(val id: Long, val label: String, val supportsReminder: Boolean)

    fun execute(payload: JSONObject, callback: (JSONObject) -> Unit) {
        val start = OffsetDateTime.parse(payload.getString("start")).toInstant().toEpochMilli()
        val end = OffsetDateTime.parse(payload.getString("end")).toInstant().toEpochMilli()
        require(end > start)
        require(payload.getString("title").length in 1..200)
        require(payload.optString("description").length <= 2000)
        require(payload.optString("location").length <= 200)
        require(payload.optInt("reminder_minutes", 10) in 0..10080)
        permissions.request(arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)) { granted ->
            if (!granted) callback(ActionDispatcher.receipt("permission_denied", "日曆讀寫權限未取得，沒有新增事件"))
            else worker.execute {
                try {
                    val calendars = calendars()
                    activity.runOnUiThread {
                        if (activity.isFinishing || activity.isDestroyed) {
                            callback(ActionDispatcher.receipt("cancelled", "畫面已關閉，沒有新增事件"))
                        } else chooseCalendar(calendars, payload, start, end, callback)
                    }
                } catch (_: SecurityException) { callback(ActionDispatcher.receipt("permission_denied", "日曆權限已撤回")) }
                catch (_: Exception) { callback(ActionDispatcher.receipt("failed", "無法讀取手機日曆")) }
            }
        }
    }

    private fun calendars(): List<Destination> {
        val destinations = mutableListOf<Destination>()
        activity.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.ACCOUNT_NAME, CalendarContract.Calendars.MAX_REMINDERS,
                CalendarContract.Calendars.ALLOWED_REMINDERS),
            "${CalendarContract.Calendars.VISIBLE} = 1 AND ${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL} >= ?",
            arrayOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR.toString()),
            "${CalendarContract.Calendars.CALENDAR_DISPLAY_NAME} ASC"
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                val name = cursor.getString(1).orEmpty().ifBlank { "日曆 $id" }
                val account = cursor.getString(2).orEmpty()
                val max = cursor.getInt(3)
                val allowed = cursor.getString(4).orEmpty().split(",").mapNotNull { it.trim().toIntOrNull() }
                destinations += Destination(id, if (account.isBlank()) name else "$name（$account）",
                    max > 0 && CalendarContract.Reminders.METHOD_ALERT in allowed)
            }
        }
        return destinations
    }

    private fun chooseCalendar(calendars: List<Destination>, payload: JSONObject, start: Long, end: Long,
                               callback: (JSONObject) -> Unit) {
        if (calendars.isEmpty()) {
            callback(ActionDispatcher.receipt("unsupported", "沒有可寫入的日曆，請先在手機日曆建立或啟用一個日曆"))
            return
        }
        AlertDialog.Builder(activity).setTitle("選擇要寫入的日曆")
            .setItems(calendars.map { it.label }.toTypedArray()) { _, index ->
                val destination = calendars[index]
                if (!destination.supportsReminder) {
                    callback(ActionDispatcher.receipt("unsupported", "所選日曆不支援 App 提醒，沒有新增事件；請選其他日曆"))
                } else {
                    NativeConfirmation.showDetailed(activity, "calendar.create", payload,
                        "日曆：${destination.label}\n這個日曆若有雲端同步，事件會依原設定同步。") { confirmed ->
                        if (!confirmed) callback(ActionDispatcher.receipt("cancelled", "已取消，沒有新增日曆事件"))
                        else worker.execute {
                            try {
                                val eventId = insert(destination.id, payload, start, end)
                                callback(ActionDispatcher.receipt("completed", "已寫入所選手機日曆並加入提醒",
                                    JSONObject().put("event_id", eventId).put("calendar_id", destination.id.toString())
                                        .put("calendar_name", destination.label)))
                            } catch (_: SecurityException) { callback(ActionDispatcher.receipt("permission_denied", "日曆權限已撤回，無法寫入")) }
                            catch (_: Exception) { callback(ActionDispatcher.receipt("failed", "日曆沒有完成寫入；請查看手機日曆及操作紀錄")) }
                        }
                    }
                }
            }.setNegativeButton("取消") { _, _ -> callback(ActionDispatcher.receipt("cancelled", "已取消日曆選擇")) }
            .setOnCancelListener { callback(ActionDispatcher.receipt("cancelled", "已取消日曆選擇")) }.show()
    }

    private fun insert(calendarId: Long, payload: JSONObject, start: Long, end: Long): String {
        val event = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calendarId)
            put(CalendarContract.Events.TITLE, payload.getString("title"))
            put(CalendarContract.Events.DTSTART, start)
            put(CalendarContract.Events.DTEND, end)
            put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
            put(CalendarContract.Events.DESCRIPTION, payload.optString("description"))
            put(CalendarContract.Events.EVENT_LOCATION, payload.optString("location"))
            put(CalendarContract.Events.HAS_ALARM, 1)
        }
        val operations = arrayListOf(
            ContentProviderOperation.newInsert(CalendarContract.Events.CONTENT_URI).withValues(event).build(),
            ContentProviderOperation.newInsert(CalendarContract.Reminders.CONTENT_URI)
                .withValueBackReference(CalendarContract.Reminders.EVENT_ID, 0)
                .withValue(CalendarContract.Reminders.MINUTES, payload.optInt("reminder_minutes", 10))
                .withValue(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT).build()
        )
        val results = activity.contentResolver.applyBatch(CalendarContract.AUTHORITY, operations)
        val id = results.firstOrNull()?.uri?.lastPathSegment
        check(!id.isNullOrBlank())
        return id
    }
}
