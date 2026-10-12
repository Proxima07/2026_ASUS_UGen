package com.proxima.localassistant.network

import org.json.JSONObject

/** Public identity only; credentials and cookie values never leave native code. */
data class PairedLoginIdentity(val userId: String, val deviceId: String) {
    companion object {
        fun native(body: JSONObject, expectedDeviceId: String): PairedLoginIdentity {
            val userId = body.opt("user_id") as? String
            val deviceId = body.opt("device_id") as? String
            if (body.opt("auth_kind") != "device" || userId.isNullOrBlank() || userId.length > 200 ||
                userId.any { it.code < 32 || it.code == 127 } || deviceId != expectedDeviceId)
                throw ApiException(200, "native_identity_invalid", "APK 身分驗證回應不符合已配對裝置")
            return PairedLoginIdentity(userId, deviceId)
        }

        fun proveCookie(body: JSONObject, expected: PairedLoginIdentity) {
            // /me gives Authorization precedence. A session proof must report session auth
            // and exactly the same user AND device as the separate native Bearer proof.
            if (body.opt("auth_kind") != "session" || body.opt("user_id") != expected.userId ||
                body.opt("device_id") != expected.deviceId)
                throw ApiException(200, "session_cookie_identity_mismatch", "Cookie 登入身分與已配對 APK 不一致")
        }
    }
}
