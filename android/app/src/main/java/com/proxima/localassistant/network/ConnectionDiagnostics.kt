package com.proxima.localassistant.network

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.security.GeneralSecurityException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException

open class ApiException(val status: Int, val code: String, message: String, val httpRequestId: String? = null) : Exception(message)

enum class ConnectionPhase(val title: String) {
    HEALTH("後端連線檢查"), PAIR_REQUEST("配對請求"), PAIR_RESPONSE("配對回應驗證"),
    PAIR_SAVE("裝置憑證加密保存"), SESSION_REQUEST("網頁登入"), SESSION_COOKIE("網頁登入 Cookie 安裝"),
    NATIVE_DEVICE_CHECK("APK 裝置驗證"), SESSION_COOKIE_VERIFY("Cookie 後端驗證")
}

/** Carry a safe phase-specific message into existing bridge errors without logging request data. */
class ConnectionFailure(val phase: ConnectionPhase, cause: Throwable, origin: String) : ApiException(
    (cause as? ApiException)?.status ?: 0,
    (cause as? ApiException)?.code?.takeIf { it in setOf("native_device_revoked", "session_cookie_unauthorized") }
        ?: "phase_${phase.name.lowercase()}",
    ConnectionDiagnostics.describe(cause, phase, origin),
    (cause as? ApiException)?.httpRequestId?.takeIf { Regex("^http_[a-f0-9]{32}$").matches(it) }
) { init { initCause(cause) } }

/** Pure JVM logic. Never renders exception messages, response bodies, tokens or pairing codes. */
object ConnectionDiagnostics {
    fun describe(error: Throwable, phase: ConnectionPhase, origin: String = "", serverAccepted: Boolean = false): String {
        val actualPhase = (error as? ConnectionFailure)?.phase ?: phase
        val causes = mutableListOf<Throwable>()
        var cursor: Throwable? = error
        while (cursor != null && causes.size < 12 && causes.none { it === cursor }) {
            causes.add(cursor); cursor = cursor.cause
        }
        val api = causes.filterIsInstance<ApiException>().firstOrNull { it !is ConnectionFailure }
        val transportError = causes.any { it is SSLException || it is IOException || it is IllegalArgumentException }
        val detail = when {
            api?.code in setOf("native_device_unauthorized", "native_device_revoked") -> "後端拒絕已保存的 APK 裝置憑證（HTTP 401），可能已停用或後端資料已重設。裝置憑證仍保留；請管理者確認裝置狀態後再決定是否重新配對。"
            api?.code == "session_cookie_queue_stalled" -> "Cookie 操作逾時，請完整關閉 App 再開，配對資料保留。"
            api?.code == "session_cookie_unauthorized" -> "APK 裝置驗證已通過，但後端拒絕 Cookie 登入（HTTP 401）。請檢查 Tunnel／代理是否保留 Cookie，以及後端 session 資料。裝置憑證仍保留。"
            api?.code == "session_cookie_missing" -> "APK 裝置驗證已通過，但 WebView 沒有可用的登入 Cookie。裝置憑證仍保留，請重新建立登入。"
            api?.code == "session_cookie_invalid" -> "登入 Cookie 格式、安全設定或數量不符合要求。請檢查後端與代理 Cookie 設定；裝置憑證仍保留。"
            api?.code == "session_cookie_not_updated" -> "WebView 沒有保存這次新建立的登入 Cookie。裝置配對憑證仍保留，請重新建立登入。"
            api?.code == "session_cookie_identity_mismatch" -> "Cookie 登入身分與已配對 APK 的使用者或裝置不一致。尚未開啟助理；裝置憑證仍保留。"
            api?.code in setOf("native_identity_invalid", "session_identity_mismatch") -> "後端回應的登入身分不符合已配對裝置，尚未開啟助理；裝置憑證仍保留。"
            actualPhase == ConnectionPhase.PAIR_SAVE -> "Android Keystore 或本機加密檔案保存失敗，尚未完成裝置憑證保存。"
            actualPhase == ConnectionPhase.SESSION_COOKIE -> "WebView 未接受安全登入 Cookie，請更新 Android System WebView 後重試。"
            api?.status in setOf(301, 302, 303, 307, 308) -> "伺服器回傳 HTTP ${api?.status} 重新導向；請檢查 Cloudflare Access、登入頁或網址轉址設定。"
            api?.status == 401 && api.code == "invalid_pairing_code" -> "配對碼已過期、已使用或不正確。有效期限內使用過也不能重用；請產生一組新的配對碼，只在 APK 使用。"
            api?.status == 401 && actualPhase == ConnectionPhase.PAIR_REQUEST -> "配對 API 回傳 HTTP 401。請確認配對碼正確，並使用一組尚未被網頁或其他裝置使用的新碼。"
            api?.status == 401 -> "伺服器或代理回傳 HTTP 401；請檢查後端與 Cloudflare Access／代理設定，尚不能判定裝置憑證已失效。"
            api?.status == 403 -> "伺服器拒絕請求（HTTP 403）；可能是 Cloudflare Access、WAF 或後端授權規則，瀏覽器可開啟仍不代表 APK 已獲准。"
            api?.status == 429 -> "請求過於頻繁（HTTP 429），請稍後再試。"
            api?.code in setOf("invalid_json_response", "empty_response") -> "收到成功狀態，但回應不是有效 JSON；網址可能指向網站或登入／驗證頁，而非後端 API。"
            api?.code == "response_too_large" -> "API 回應超過預期上限；請檢查是否被代理或登入頁改寫。"
            api?.code == "unexpected_backend" -> "收到 JSON，但不是本系統的正常 backend /health 回應；請檢查 Tunnel 指向的服務。"
            api?.code == "invalid_pairing_response" -> "後端回應缺少有效裝置憑證或 ID，無法完成配對。"
            api != null && api.status > 0 -> "API 回傳 HTTP ${api.status}，請檢查後端或代理服務。"
            causes.any { it is SSLPeerUnverifiedException || it is CertificateException } -> "HTTPS 憑證或主機名稱驗證失敗；請修正網址／憑證，不能略過驗證。"
            causes.any { it is SSLException } -> "HTTPS／TLS 握手失敗；請檢查憑證、手機時間與代理服務。"
            causes.any { it is UnknownHostException } -> "手機無法解析主機名稱，請檢查 DNS 與手機網路。"
            causes.any { it is SocketTimeoutException } -> "後端連線或讀取逾時，請檢查 Tunnel 與服務是否運作。"
            causes.any { it is ConnectException } -> "無法建立後端連線，請檢查手機網路、Tunnel 與服務。"
            causes.any { it is GeneralSecurityException } -> "Android 加密或金鑰服務失敗，請確認裝置安全服務正常。"
            causes.any { it is IOException } -> "網路傳輸失敗，請檢查手機網路、TLS 與代理服務。"
            causes.any { it is IllegalArgumentException } -> "連線參數或 TLS/SNI 主機名稱無法處理，請檢查 HTTPS 網址。"
            else -> "此階段未完成；請先執行「檢查後端連線」，確認後端回應再重試。"
        }
        val sniHint = if (transportError && actualPhase != ConnectionPhase.PAIR_SAVE && hasUnderscoreHost(origin))
            "\n主機名稱含「_」，可能影響部分 Android TLS/SNI 實作；可改用英文字母、數字與連字號「-」的子網域測試。" else ""
        val acceptedHint = if (actualPhase == ConnectionPhase.PAIR_SAVE || serverAccepted && actualPhase == ConnectionPhase.PAIR_RESPONSE)
            "\n伺服器已接受配對請求，這組一次性配對碼已消耗；重試配對前需要新碼。"
        else if (api?.status == 200 && actualPhase in setOf(ConnectionPhase.PAIR_REQUEST, ConnectionPhase.PAIR_RESPONSE))
            "\n伺服器可能已接受配對，原碼可能已使用；請先檢查後端，再用新碼重試。" else ""
        val metadata = buildString {
            if (api?.status in 100..599) append("\nHTTP：${api?.status}")
            api?.httpRequestId?.takeIf { Regex("^http_[a-f0-9]{32}$").matches(it) }?.let { append("\n請求 ID：$it") }
        }
        return "${actualPhase.title}失敗：$detail$sniHint$acceptedHint$metadata"
    }

    private fun hasUnderscoreHost(origin: String): Boolean = try {
        // Java URI.host can be null for underscore hostnames; authority still lets us warn safely.
        URI(origin).rawAuthority?.contains('_') == true
    } catch (_: Exception) { false }
}
