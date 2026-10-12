package com.proxima.localassistant.actions

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

class DialHandler(private val activity: Activity) {
    fun execute(payload: JSONObject, callback: (JSONObject) -> Unit) {
        val raw = payload.getString("phone_number")
        require(raw.length in 3..32 && raw.matches(Regex("^\\+?[0-9][0-9 ()-]{1,30}[0-9]$")))
        val number = raw.filter { it in '0'..'9' || it == '+' }
        try {
            activity.startActivity(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)))
            callback(ActionDispatcher.receipt("opened", "已開啟撥號畫面，請在電話 App 確認通話",
                JSONObject().put("phone_number", number)))
        } catch (_: ActivityNotFoundException) {
            callback(ActionDispatcher.receipt("unsupported", "這支手機沒有可開啟的電話 App"))
        }
    }
}
