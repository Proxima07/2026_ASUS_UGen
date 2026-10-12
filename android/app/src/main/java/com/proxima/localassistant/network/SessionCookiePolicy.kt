package com.proxima.localassistant.network

import java.security.MessageDigest

/** Never returns or reports unrelated browser cookies. Error text contains no secret values. */
object SessionCookiePolicy {
    private const val NAME = "local_assistant_session"
    private val tokenPattern = Regex("^[A-Za-z0-9_-]{20,500}$")

    fun freshToken(setCookie: String): String {
        if (setCookie.length !in 1..4096 || setCookie.any { it == '\r' || it == '\n' }) invalid()
        val parts = setCookie.split(';').map { it.trim() }
        val first = parts.first().split('=', limit = 2)
        if (first.size != 2 || first[0] != NAME || !tokenPattern.matches(first[1])) invalid()
        val attributes = parts.drop(1).map { it.split('=', limit = 2) }
        fun values(key: String) = attributes.filter { it[0].equals(key, true) }
        fun flag(key: String) = values(key).size == 1 && values(key)[0].size == 1
        fun attribute(key: String): String? = values(key).singleOrNull()?.getOrNull(1)
        if (!flag("secure") || !flag("httponly") || attribute("path") != "/" ||
            !attribute("samesite").orEmpty().equals("strict", true) || values("domain").isNotEmpty() ||
            (attribute("max-age")?.toLongOrNull() ?: 0L) !in 1..604800) invalid()
        return first[1]
    }
    fun requestHeader(stored: String?, expectedFreshToken: String? = null): String {
        if (stored.isNullOrBlank()) missing()
        if (stored.length > 8192 || stored.any { it == '\r' || it == '\n' }) invalid()
        val matches = stored.split(';').map { it.trim().split('=', limit = 2) }
            .filter { it.firstOrNull() == NAME }
        if (matches.isEmpty()) missing()
        if (matches.size != 1 || matches[0].size != 2 || !tokenPattern.matches(matches[0][1])) invalid()
        val token = matches[0][1]
        if (expectedFreshToken != null && !MessageDigest.isEqual(token.toByteArray(), expectedFreshToken.toByteArray()))
            throw ApiException(0, "session_cookie_not_updated", "WebView 沒有保存這次新建立的登入 Cookie。裝置配對憑證仍保留，請重新建立登入。")
        return "$NAME=$token"
    }
    private fun missing(): Nothing = throw ApiException(0, "session_cookie_missing",
        "APK 裝置驗證已通過，但 WebView 沒有可用的登入 Cookie。裝置憑證仍保留，請重新建立登入。")
    private fun invalid(): Nothing = throw ApiException(0, "session_cookie_invalid",
        "登入 Cookie 格式、安全設定或數量不符合要求。請檢查後端與代理 Cookie 設定；裝置憑證仍保留。")
}
