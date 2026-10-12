package com.proxima.localassistant.security

import android.content.Context
import org.json.JSONObject

data class DeviceCredential(val origin: String, val token: String, val deviceId: String)
class DeviceCredentialStore(context: Context) {
    private val file = EncryptedFile(context, "device-credential.enc")
    @Synchronized fun load(): DeviceCredential? = file.read()?.let {
        val value = JSONObject(it)
        DeviceCredential(value.getString("origin"), value.getString("token"), value.getString("device_id"))
    }
    @Synchronized fun save(value: DeviceCredential) { file.write(JSONObject()
        .put("origin", value.origin).put("token", value.token).put("device_id", value.deviceId).toString()) }
    @Synchronized fun clear() { file.delete() }
}
