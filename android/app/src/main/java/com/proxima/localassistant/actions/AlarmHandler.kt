package com.proxima.localassistant.actions

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.AlarmClock
import org.json.JSONObject

class AlarmHandler(private val activity: Activity) {
    fun execute(payload: JSONObject, callback: (JSONObject) -> Unit) {
        val hour = payload.getInt("hour")
        val minute = payload.getInt("minute")
        require(hour in 0..23 && minute in 0..59)
        val label = payload.optString("label", "提醒")
        require(label.length <= 100)
        val array = payload.optJSONArray("weekdays")
        val days = ArrayList<Int>()
        if (array != null) {
            require(array.length() <= 7)
            for (i in 0 until array.length()) {
                val day = array.getInt(i)
                require(day in 1..7 && day !in days)
                days.add(day)
            }
        }
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_MESSAGE, label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, false)
        if (days.isNotEmpty()) intent.putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, days)
        try {
            activity.startActivity(intent)
            callback(ActionDispatcher.receipt("handed_off", "已交給時鐘 App，請確認鬧鐘是否已建立",
                JSONObject().put("hour", hour).put("minute", minute)))
        } catch (_: ActivityNotFoundException) {
            callback(ActionDispatcher.receipt("unsupported", "這支手機沒有支援設定鬧鐘的時鐘 App"))
        }
    }
}
