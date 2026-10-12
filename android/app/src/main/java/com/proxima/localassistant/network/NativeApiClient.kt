package com.proxima.localassistant.network

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, val code: String, message: String) : Exception(message)
class NativeApiClient(val origin: String, private val token: String? = null) {
    private val base = validateOrigin(origin).toHttpUrl()
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    fun call(method: String, path: String, body: JSONObject? = null): Pair<JSONObject, List<String>> {
        require(path.startsWith("/v1/") && !path.contains("?") && !path.contains("#"))
        val url = base.newBuilder().encodedPath(path).build()
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        if (token != null) builder.header("Authorization", "Bearer $token")
        builder.method(method, if (method == "GET") null else (body ?: JSONObject()).toString().toRequestBody(jsonType))
        http.newCall(builder.build()).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            val parsed = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            if (!response.isSuccessful) {
                val detail = parsed.optJSONObject("detail") ?: parsed.optJSONObject("error") ?: parsed
                throw ApiException(response.code, detail.optString("code", "http_${response.code}"),
                    detail.optString("message", "服務拒絕請求（HTTP ${response.code}）"))
            }
            if (raw.isBlank()) throw ApiException(response.code, "empty_response", "服務回傳空白內容")
            return Pair(parsed, response.headers.values("Set-Cookie"))
        }
    }
    fun getAction(actionId: String) = call("GET", "/v1/actions/${safeId(actionId)}").first
    fun confirm(actionId: String) = call("POST", "/v1/actions/${safeId(actionId)}/confirm").first
    fun cancel(actionId: String) = call("POST", "/v1/actions/${safeId(actionId)}/cancel").first
    fun result(actionId: String, token: String, state: String, result: JSONObject) = call("POST",
        "/v1/actions/${safeId(actionId)}/result", JSONObject().put("execution_token", token).put("state", state).put("result", result)).first
    fun getNote(noteId: String) = call("GET", "/v1/notes/${safeId(noteId)}").first
    fun session() = call("POST", "/v1/auth/session")
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
