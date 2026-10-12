package com.proxima.localassistant.web

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.ByteArrayInputStream

class TrustedWebViewClient(private val activity: Activity, private val origin: String,
                          private val onNavigation: () -> Unit = {}) : WebViewClient() {
    fun trusted(uri: Uri): Boolean {
        val value = uri.toString().toHttpUrlOrNull() ?: return false
        val expected = origin.toHttpUrlOrNull() ?: return false
        return value.scheme == "https" && value.host == expected.host && value.port == expected.port
            && value.username.isEmpty() && value.password.isEmpty()
    }
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (trusted(request.url)) return false
        // Native intents are created only from authenticated backend actions, never arbitrary links.
        if (request.isForMainFrame && request.hasGesture() && request.url.scheme == "https") {
            AlertDialog.Builder(activity).setTitle("離開本地助理")
                .setMessage("將使用手機瀏覽器開啟外部網站，該頁面無法操作本 APK。")
                .setPositiveButton("開啟") { _, _ -> try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: Exception) { Toast.makeText(activity, "沒有可開啟的瀏覽器", Toast.LENGTH_SHORT).show() } }
                .setNegativeButton("取消", null).show()
        }
        return true
    }
    override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        onNavigation()
        super.onPageStarted(view, url, favicon)
    }
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (trusted(request.url)) return null
        return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
        Toast.makeText(activity, "HTTPS 憑證驗證失敗。請修正網址或伺服器憑證，勿略過驗證。", Toast.LENGTH_LONG).show()
    }
}
