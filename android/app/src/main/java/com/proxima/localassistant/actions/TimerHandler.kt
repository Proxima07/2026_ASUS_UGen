package com.proxima.localassistant.actions

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.AlarmClock
import org.json.JSONObject

/** Hands a duration to a clock app; no fixed-time alarm or app-owned background timer. */
class TimerHandler(private val activity: Activity) {
    fun execute(payload: JSONObject, callback: (JSONObject) -> Unit) {
        val duration = payload.getInt("duration_seconds")
        require(duration in 1..86400)
        val label = payload.optString("label", "倒數計時")
        require(label.length <= 200)
        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, duration)
            .putExtra(AlarmClock.EXTRA_MESSAGE, label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, false)
        if (intent.resolveActivity(activity.packageManager) == null) {
            callback(ActionDispatcher.receipt("unsupported", "這支手機沒有支援倒數計時的時鐘 App"))
            return
        }
        try {
            activity.startActivity(intent)
            callback(ActionDispatcher.receipt("handed_off",
                "已將倒數計時 ${formatDuration(duration)} 交給時鐘 App，請在該 App 確認是否開始計時",
                JSONObject().put("duration_seconds", duration).put("label", label)))
        } catch (_: ActivityNotFoundException) {
            callback(ActionDispatcher.receipt("unsupported", "這支手機沒有支援倒數計時的時鐘 App"))
        }
    }

    companion object {
        fun formatDuration(seconds: Int): String {
            require(seconds in 1..86400)
            val hours = seconds / 3600
            val minutes = (seconds % 3600) / 60
            val remainder = seconds % 60
            return buildString {
                if (hours > 0) append("${hours}小時")
                if (minutes > 0) append("${minutes}分")
                if (remainder > 0) append("${remainder}秒")
            }
        }
    }
}
