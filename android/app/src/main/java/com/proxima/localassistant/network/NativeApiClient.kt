package com.proxima.localassistant.network

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Call
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

class NativeApiClient(val origin: String, private val token: String? = null) {
    private val base = validateOrigin(origin).toHttpUrl()
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    fun call(method: String, path: String, body: JSONObject? = null): Pair<JSONObject, List<String>> {
        require((path.startsWith("/v1/") || method == "GET" && path == "/health") && !path.contains("?") && !path.contains("#"))
        val url = base.newBuilder().encodedPath(path).build()
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        if (token != null && path != "/health") builder.header("Authorization", "Bearer $token")
        builder.method(method, if (method == "GET") null else (body ?: JSONObject()).toString().toRequestBody(jsonType))
        return decode(http.newCall(builder.build()).execute())
    }
    private fun decode(response: Response): Pair<JSONObject, List<String>> {
        response.use {
            val source = response.body?.source()
            source?.request(2097153)
            if ((source?.buffer?.size ?: 0L) > 2097152)
                throw ApiException(response.code, "response_too_large", "API 回應超過預期上限")
            val raw = source?.readUtf8().orEmpty()
            val parsed = try { JSONObject(raw) } catch (_: Exception) { null }
            if (!response.isSuccessful) {
                val detail = parsed?.optJSONObject("detail") ?: parsed?.optJSONObject("error") ?: parsed
                val receivedCode = detail?.optString("code").orEmpty()
                val safeCode = if (Regex("^[a-zA-Z0-9_]{1,64}$").matches(receivedCode)) receivedCode else "http_${response.code}"
                throw ApiException(response.code, safeCode, "服務拒絕請求（HTTP ${response.code}）")
            }
            if (raw.isBlank()) throw ApiException(response.code, "empty_response", "服務回傳空白內容")
            if (parsed == null) throw ApiException(response.code, "invalid_json_response", "服務回應不是有效 JSON")
            return Pair(parsed, response.headers.values("Set-Cookie"))
        }
    }
    /** Complete local file only: never a JS-supplied URL, path or unbounded base64 body. */
    fun commandAudioUpload(file: File): Call {
        require(token != null && file.isFile && file.length() in 1..8_388_608L)
        val url = base.newBuilder().encodedPath("/v1/audio").addQueryParameter("purpose", "command").build()
        val request = Request.Builder().url(url).header("Accept", "application/json")
            .header("Authorization", "Bearer $token").post(file.asRequestBody("audio/mp4".toMediaType())).build()
        return http.newCall(request)
    }
    fun executeAudioUpload(call: Call): JSONObject = decode(call.execute()).first
    fun identityCall(): Call {
        require(token != null)
        val request = Request.Builder().url(base.newBuilder().encodedPath("/v1/auth/me").build())
            .header("Accept", "application/json").header("Authorization", "Bearer $token").get().build()
        return http.newBuilder().callTimeout(15, TimeUnit.SECONDS).build().newCall(request)
    }
    fun executeIdentity(call: Call): JSONObject = decode(call.execute()).first
    fun me() = executeIdentity(identityCall())
    fun getAction(actionId: String) = call("GET", "/v1/actions/${safeId(actionId)}").first
    fun confirm(actionId: String) = call("POST", "/v1/actions/${safeId(actionId)}/confirm").first
    fun cancel(actionId: String) = call("POST", "/v1/actions/${safeId(actionId)}/cancel").first
    fun result(actionId: String, token: String, state: String, result: JSONObject) = call("POST",
        "/v1/actions/${safeId(actionId)}/result", JSONObject().put("execution_token", token).put("state", state).put("result", result)).first
    fun getNote(noteId: String) = call("GET", "/v1/notes/${safeId(noteId)}").first
    fun session() = call("POST", "/v1/auth/session")
    fun health(): JSONObject {
        val result = call("GET", "/health").first
        if (result.optString("status") != "ok" || result.optString("component") != "backend")
            throw ApiException(200, "unexpected_backend", "回應不是本系統的 backend health")
        return result
    }
    companion object {
        fun validateOrigin(raw: String): String {
            val url = raw.trim().toHttpUrl()
            require(url.scheme == "https" && url.username.isEmpty() && url.password.isEmpty()
                && url.query == null && url.fragment == null && url.encodedPath == "/") {
                "請使用 HTTPS 網站根網址，例如 https://assistant.example.com"
            }
            return url.toString().removeSuffix("/")
        }
        fun safeId(id: String): String { require(Regex("^[A-Za-z0-9_-]{1,128}$").matches(id)); return id }
    }
}
