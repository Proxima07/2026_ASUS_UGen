package com.proxima.localassistant.network

/**
 * Dependency-free JVM regression checks. Run this object's main with the Kotlin standard library
 * after compiling it together with SessionCookiePolicy.kt and ConnectionDiagnostics.kt.
 * No Android runtime, WebView, network, test framework, or real credentials are needed.
 */
object SessionCookiePolicyTest {
    private const val NAME = "local_assistant_session"
    private val fresh = "Fresh_session_token_1234567890"
    private val previous = "Previous_session_token_1234567890"
    private var checks = 0

    @JvmStatic
    fun main(args: Array<String>) {
        freshCookieChecks()
        storedCookieChecks()
        diagnosticsChecks()
        println("SessionCookiePolicy: $checks checks passed")
    }

    private fun cookie(token: String = fresh): String =
        "$NAME=$token; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600"

    private fun freshCookieChecks() {
        equal(fresh, SessionCookiePolicy.freshToken(cookie()), "valid fresh cookie")
        equal(fresh, SessionCookiePolicy.freshToken(
            "$NAME=$fresh; pAtH=/; sEcUrE; hTtPoNlY; sAmEsItE=sTrIcT; mAx-AgE=1"
        ), "attribute names and SameSite are case insensitive")
        equal(fresh, SessionCookiePolicy.freshToken(cookie().replace("Max-Age=3600", "Max-Age=604800")),
            "maximum session lifetime")
        for (length in listOf(20, 500)) {
            val token = "a".repeat(length)
            equal(token, SessionCookiePolicy.freshToken(cookie(token)), "token length $length")
        }

        val invalid = linkedMapOf(
            "empty cookie" to "",
            "unrelated cookie" to cookie().replace(NAME, "another_session"),
            "missing token separator" to cookie().replace("$NAME=$fresh", NAME),
            "empty token" to cookie(""),
            "short token" to cookie("a".repeat(19)),
            "long token" to cookie("a".repeat(501)),
            "unsafe token character" to cookie("invalid/token_1234567890"),
            "missing Secure" to cookie().replace("; Secure", ""),
            "valued Secure flag" to cookie().replace("Secure;", "Secure=true;"),
            "duplicate Secure" to "${cookie()}; Secure",
            "missing HttpOnly" to cookie().replace("; HttpOnly", ""),
            "duplicate HttpOnly" to "${cookie()}; HttpOnly",
            "non-root Path" to cookie().replace("Path=/", "Path=/api"),
            "missing Path" to cookie().replace("; Path=/", ""),
            "duplicate Path" to "${cookie()}; Path=/",
            "non-strict SameSite" to cookie().replace("SameSite=Strict", "SameSite=Lax"),
            "missing SameSite" to cookie().replace("; SameSite=Strict", ""),
            "duplicate SameSite" to "${cookie()}; SameSite=Strict",
            "Domain scope" to "${cookie()}; Domain=example.test",
            "empty Domain scope" to "${cookie()}; Domain=",
            "missing Max-Age" to cookie().replace("; Max-Age=3600", ""),
            "zero Max-Age" to cookie().replace("Max-Age=3600", "Max-Age=0"),
            "negative Max-Age" to cookie().replace("Max-Age=3600", "Max-Age=-1"),
            "excessive Max-Age" to cookie().replace("Max-Age=3600", "Max-Age=604801"),
            "malformed Max-Age" to cookie().replace("Max-Age=3600", "Max-Age=not-a-number"),
            "duplicate Max-Age" to "${cookie()}; Max-Age=3600",
            "response header injection" to "${cookie()}\r\nSet-Cookie: other=secret",
            "newline injection" to "${cookie()}\n",
            "oversized response header" to "${cookie()}; Extra=${"a".repeat(4096)}"
        )
        for ((label, input) in invalid) {
            failure("session_cookie_invalid", label, listOf(fresh)) { SessionCookiePolicy.freshToken(input) }
        }
    }

    private fun storedCookieChecks() {
        equal("$NAME=$fresh", SessionCookiePolicy.requestHeader("$NAME=$fresh"), "session-only header")
        equal("$NAME=$fresh", SessionCookiePolicy.requestHeader(
            "analytics=unrelated_cookie_secret; $NAME=$fresh; preference=dark; malformed"
        ), "unrelated browser cookies are stripped")
        equal("$NAME=$fresh", SessionCookiePolicy.requestHeader(
            "  preference=dark ;  $NAME=$fresh  ; analytics=unrelated_cookie_secret ", fresh
        ), "fresh token verification with surrounding whitespace")
        equal("$NAME=$fresh", SessionCookiePolicy.requestHeader("$NAME=$fresh", fresh),
            "matching freshly installed token")

        for ((label, input) in linkedMapOf<String, String?>(
            "null Cookie header" to null,
            "empty Cookie header" to "",
            "blank Cookie header" to "   ",
            "unrelated cookies only" to "analytics=unrelated_cookie_secret; preference=dark"
        )) {
            failure("session_cookie_missing", label, listOf(fresh, "unrelated_cookie_secret")) {
                SessionCookiePolicy.requestHeader(input)
            }
        }
        for ((label, input) in linkedMapOf(
            "duplicate identical session cookies" to "$NAME=$fresh; $NAME=$fresh",
            "duplicate different session cookies" to "$NAME=$previous; $NAME=$fresh",
            "missing token separator" to NAME,
            "empty session token" to "$NAME=",
            "short session token" to "$NAME=${"a".repeat(19)}",
            "long session token" to "$NAME=${"a".repeat(501)}",
            "invalid session token" to "$NAME=invalid/token_1234567890",
            "quoted token" to "$NAME=\"$fresh\"",
            "request header injection" to "$NAME=$fresh\r\nX-Test: unrelated_cookie_secret",
            "newline injection" to "$NAME=$fresh\n",
            "oversized Cookie header" to "other=${"a".repeat(8192)}; $NAME=$fresh"
        )) {
            failure("session_cookie_invalid", label, listOf(fresh, previous, "unrelated_cookie_secret")) {
                SessionCookiePolicy.requestHeader(input)
            }
        }
        failure("session_cookie_not_updated", "WebView kept the previous session token", listOf(fresh, previous)) {
            SessionCookiePolicy.requestHeader("$NAME=$previous", fresh)
        }
        failure("session_cookie_not_updated", "expected token differs only in length", listOf(fresh)) {
            SessionCookiePolicy.requestHeader("$NAME=$fresh", "${fresh}x")
        }
    }

    private fun diagnosticsChecks() {
        val requestId = "http_0123456789abcdef0123456789abcdef"
        val unsafeMessage = "untrusted_server_message_with_session_secret_1234567890"
        val revoked = ConnectionFailure(ConnectionPhase.NATIVE_DEVICE_CHECK,
            ApiException(401, "native_device_revoked", unsafeMessage, requestId), "https://example.test")
        check(revoked.status == 401 && revoked.code == "native_device_revoked" && revoked.httpRequestId == requestId) {
            "native device rejection lost its HTTP status, semantic code, or safe request ID"
        }
        val revokedDiagnostic = ConnectionDiagnostics.describe(revoked, ConnectionPhase.HEALTH)
        check(revokedDiagnostic.startsWith(ConnectionPhase.NATIVE_DEVICE_CHECK.title) &&
            revokedDiagnostic.contains("HTTP：401") && revokedDiagnostic.contains(requestId) &&
            revokedDiagnostic.contains("裝置憑證仍保留") && !revokedDiagnostic.contains(unsafeMessage)) {
            "native device rejection did not preserve safe troubleshooting context"
        }
        checks++

        val cookieRejected = ConnectionFailure(ConnectionPhase.SESSION_COOKIE_VERIFY,
            ApiException(401, "session_cookie_unauthorized", unsafeMessage, requestId), "https://example.test")
        check(cookieRejected.status == 401 && cookieRejected.code == "session_cookie_unauthorized" &&
            cookieRejected.code != revoked.code && cookieRejected.httpRequestId == requestId) {
            "Cookie HTTP 401 was confused with native device revocation"
        }
        val cookieDiagnostic = ConnectionDiagnostics.describe(cookieRejected, ConnectionPhase.HEALTH)
        check(cookieDiagnostic.startsWith(ConnectionPhase.SESSION_COOKIE_VERIFY.title) &&
            cookieDiagnostic.contains("APK 裝置驗證已通過") && cookieDiagnostic.contains("Cookie") &&
            cookieDiagnostic.contains("HTTP：401") && cookieDiagnostic.contains(requestId) &&
            !cookieDiagnostic.contains(unsafeMessage)) {
            "Cookie rejection lost its separate meaning or leaked server text"
        }
        checks++

        for (unsafeRequestId in listOf(
            "$requestId\r\nAuthorization: Bearer $fresh",
            "http_0123456789abcdef0123456789abcde",
            "http_0123456789abcdef0123456789abcdef0",
            "http_0123456789ABCDEF0123456789ABCDEF",
            fresh,
            ""
        )) {
            val error = ApiException(401, "native_device_revoked", unsafeMessage, unsafeRequestId)
            val wrapped = ConnectionFailure(ConnectionPhase.NATIVE_DEVICE_CHECK, error, "https://example.test")
            val displayed = ConnectionDiagnostics.describe(wrapped, ConnectionPhase.HEALTH)
            check(wrapped.httpRequestId == null && !displayed.contains("請求 ID：") &&
                !displayed.contains(fresh) && !displayed.contains(unsafeMessage)) {
                "untrusted request ID escaped sanitization"
            }
            checks++
        }

        for (code in listOf(
            "session_cookie_missing", "session_cookie_invalid", "session_cookie_not_updated",
            "session_cookie_identity_mismatch", "native_identity_invalid", "session_identity_mismatch",
            "unrecognized_server_code"
        )) {
            val error = ApiException(401, code, unsafeMessage, requestId)
            val wrapped = ConnectionFailure(ConnectionPhase.SESSION_COOKIE_VERIFY, error, "https://example.test")
            val displayed = ConnectionDiagnostics.describe(wrapped, ConnectionPhase.HEALTH)
            check(!wrapped.message.orEmpty().contains(unsafeMessage) && !displayed.contains(unsafeMessage) &&
                wrapped.code == "phase_session_cookie_verify" && wrapped.httpRequestId == requestId) {
                "server exception text was rendered or an unrelated code was exposed as a semantic failure"
            }
            checks++
        }

        for (phase in listOf(ConnectionPhase.SESSION_COOKIE, ConnectionPhase.SESSION_COOKIE_VERIFY)) {
            val unsafe = ApiException(0, "session_cookie_queue_stalled", unsafeMessage)
            val neutral = ApiException(0, "session_cookie_queue_stalled", "Cookie operation timed out")
            val wrapped = ConnectionFailure(phase, unsafe, "https://example.test")
            equal(ConnectionDiagnostics.describe(neutral, phase), wrapped.message.orEmpty(),
                "stalled Cookie queue uses fixed native diagnostic for $phase")
            check(wrapped.message.orEmpty().startsWith(phase.title) &&
                !wrapped.message.orEmpty().contains(unsafeMessage)) {
                "stalled Cookie queue leaked exception text or lost its phase"
            }
        }
    }

    private fun equal(expected: String, actual: String, label: String) {
        check(actual == expected) { "$label: result did not match" }
        checks++
    }

    private fun failure(code: String, label: String, secretValues: List<String>, block: () -> String) {
        val exception = try {
            block()
            error("$label: invalid input was accepted")
        } catch (error: ApiException) {
            error
        }
        check(exception.status == 0 && exception.code == code) {
            "$label: expected $code, got status ${exception.status}, code ${exception.code}"
        }
        val displayed = ConnectionDiagnostics.describe(exception, ConnectionPhase.SESSION_COOKIE_VERIFY)
        check(displayed.contains(ConnectionPhase.SESSION_COOKIE_VERIFY.title)) { "$label: phase was lost" }
        for (secret in secretValues) {
            check(!exception.message.orEmpty().contains(secret) && !displayed.contains(secret)) {
                "$label: secret leaked into diagnostic"
            }
        }
        checks++
    }
}
