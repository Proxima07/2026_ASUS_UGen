package com.proxima.localassistant.network

import android.content.Context
import com.proxima.localassistant.security.DeviceCredential
import java.security.MessageDigest

/** Persistent, account-bound diagnostics containing no token, cookie or server response. */
class LoginDiagnosticsStore(context: Context) {
    private val preferences = context.getSharedPreferences("paired-login-diagnostics", Context.MODE_PRIVATE)

    fun read(credential: DeviceCredential): String = preferences.getString(key(credential), "").orEmpty()

    fun progress(credential: DeviceCredential, phase: ConnectionPhase): String =
        save(credential, "${phase.title}：檢查中…")

    fun passed(credential: DeviceCredential, phase: ConnectionPhase): String =
        save(credential, "${phase.title}：已通過（HTTP 200）")

    fun ready(credential: DeviceCredential): String = save(credential,
        "登入檢查通過：APK 裝置驗證與 Cookie 後端驗證均成功，使用者及裝置一致（HTTP 200）。")

    fun failed(credential: DeviceCredential, error: Throwable, phase: ConnectionPhase): String =
        save(credential, ConnectionDiagnostics.describe(error, phase, credential.origin))

    private fun save(credential: DeviceCredential, safeText: String): String {
        // Values are exclusively fixed native messages plus validated HTTP metadata.
        preferences.edit().putString(key(credential), safeText).apply()
        return safeText
    }

    private fun key(credential: DeviceCredential): String = MessageDigest.getInstance("SHA-256")
        .digest("${credential.origin}|${credential.deviceId}".toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}
