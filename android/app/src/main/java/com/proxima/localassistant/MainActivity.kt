package com.proxima.localassistant

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.proxima.localassistant.actions.ActionDispatcher
import com.proxima.localassistant.bridge.BridgeController
import com.proxima.localassistant.network.NativeApiClient
import com.proxima.localassistant.network.ApiException
import com.proxima.localassistant.network.ConnectionDiagnostics
import com.proxima.localassistant.network.ConnectionFailure
import com.proxima.localassistant.network.ConnectionPhase
import com.proxima.localassistant.permissions.PermissionController
import com.proxima.localassistant.security.DeviceCredential
import com.proxima.localassistant.security.DeviceCredentialStore
import com.proxima.localassistant.security.ExecutionReceiptStore
import com.proxima.localassistant.ui.NativeConfirmation
import com.proxima.localassistant.web.TrustedWebViewClient
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class MainActivity : Activity() {
    companion object {
        private val APP_WORKER = Executors.newSingleThreadExecutor()
        private val APP_ACTIVITY_VERSION = AtomicLong()
        // CookieManager is process-global, so its asynchronous mutation queue must be too.
        private var cookieInstallRunning = false
        private var pendingCookieInstall: (() -> Unit)? = null
    }
    private val worker = APP_WORKER
    private lateinit var credentials: DeviceCredentialStore
    private lateinit var permissions: PermissionController
    private lateinit var receipts: ExecutionReceiptStore
    private var webView: WebView? = null
    private var bridge: BridgeController? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val documentRequest = 4001
    private var screenVersion = 0
    private var sessionVersion = 0
    private var currentCredential: DeviceCredential? = null
    private var foreground = false
    private var activityVersion = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityVersion = APP_ACTIVITY_VERSION.incrementAndGet()
        credentials = DeviceCredentialStore(this)
        permissions = PermissionController(this)
        val credential = try { credentials.load() } catch (_: Exception) {
            toast("裝置憑證無法解密，請重新配對")
            null
        }
        if (credential == null) showSetup() else openAssistant(credential)
    }
    private fun showSetup(initialMessage: String = "") {
        val setupVersion = ++screenVersion
        ++sessionVersion
        currentCredential = null
        NativeConfirmation.cancelForActivity(this)
        bridge?.cancelRecording("navigation")
        webView?.let { it.stopLoading(); it.destroy() }
        webView = null; bridge = null
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(28), dp(24), dp(24))
            setBackgroundColor(Color.rgb(247, 249, 246))
        }
        column.addView(TextView(this).apply { text = "本地助理 · 裝置配對"; textSize = 26f; setTextColor(Color.rgb(30, 55, 45)) })
        column.addView(TextView(this).apply {
            text = "請填入由你管理的 HTTPS 網站及一次性配對碼。可先檢查後端連線，再使用新碼配對；網頁與 APK 各需要自己的配對碼。"
            textSize = 16f; setPadding(0, dp(16), 0, dp(20))
        })
        val previous = try { credentials.load() } catch (_: Exception) { null }
        val origin = EditText(this).apply { hint = "https://assistant.example.com"; setText(previous?.origin.orEmpty()); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI; setSingleLine(true) }
        val label = EditText(this).apply { hint = "裝置名稱"; setText("Android ${Build.MODEL}".take(100)); setSingleLine(true) }
        val code = EditText(this).apply { hint = "一次性配對碼"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; setSingleLine(true) }
        val status = TextView(this).apply { text = initialMessage; textSize = 14f; setPadding(0, dp(16), 0, dp(16)); setTextIsSelectable(true) }
        column.addView(origin); column.addView(label); column.addView(code); column.addView(status)
        val health = Button(this).apply { text = "檢查後端連線" }
        val pair = Button(this).apply { text = "配對並開啟助理" }
        column.addView(health); column.addView(pair)
        val controls = mutableListOf<View>(origin, label, code, health, pair)
        fun active(): Boolean = isCurrentActivity() && setupVersion == screenVersion
        fun busy(value: Boolean) { controls.forEach { it.isEnabled = !value } }
        fun endpoint(): String? = try { NativeApiClient.validateOrigin(origin.text.toString()) }
            catch (_: Exception) { status.text = "請輸入 HTTPS 根網址，不能包含帳號、密碼、路徑、查詢或 fragment。"; null }
        health.setOnClickListener {
            val target = endpoint() ?: return@setOnClickListener
            busy(true); status.text = "檢查 HTTPS 與 /health 中，不會傳送配對碼或裝置憑證…"
            worker.execute {
                try {
                    NativeApiClient(target).health()
                    runOnUiThread { if (active()) { busy(false); status.text = "後端連線正常：HTTPS 與 /health 已驗證，服務為 backend。可使用一組新的配對碼進行配對。" } }
                } catch (error: Exception) {
                    val message = ConnectionDiagnostics.describe(error, ConnectionPhase.HEALTH, target)
                    runOnUiThread { if (active()) { busy(false); status.text = message } }
                }
            }
        }
        pair.setOnClickListener {
            val target = endpoint() ?: return@setOnClickListener
            val pairingCode = code.text.toString().trim()
            val deviceLabel = label.text.toString().trim()
            if (pairingCode.length !in 8..200 || deviceLabel.length !in 1..100) { status.text = "請填寫有效配對碼與裝置名稱。"; return@setOnClickListener }
            busy(true); status.text = "透過 HTTPS 配對中…"
            worker.execute {
                var phase = ConnectionPhase.PAIR_REQUEST
                var accepted = false
                try {
                    val response = NativeApiClient(target).call("POST", "/v1/auth/pair", JSONObject().put("code", pairingCode).put("label", deviceLabel)).first
                    phase = ConnectionPhase.PAIR_RESPONSE
                    val token = response.opt("token") as? String
                    val deviceId = response.opt("device_id") as? String
                    if (token == null || deviceId == null || !Regex("^[A-Za-z0-9_-]{20,200}$").matches(token)
                        || !Regex("^[A-Za-z0-9_-]{1,128}$").matches(deviceId))
                        throw ApiException(200, "invalid_pairing_response", "配對回應格式不正確")
                    accepted = true
                    val credential = DeviceCredential(target, token, deviceId)
                    phase = ConnectionPhase.PAIR_SAVE
                    runOnUiThread {
                        if (!active()) return@runOnUiThread
                        try {
                            // Commit only on the still-current setup screen. A late response from
                            // an old Activity must never replace another account's local credential.
                            credentials.save(credential)
                            busy(false); code.text.clear(); openAssistant(credential)
                        } catch (error: Exception) {
                            busy(false); status.text = ConnectionDiagnostics.describe(error, ConnectionPhase.PAIR_SAVE, target, true)
                        }
                    }
                } catch (error: Exception) {
                    val message = ConnectionDiagnostics.describe(error, phase, target, accepted)
                    runOnUiThread { if (active()) { busy(false); status.text = message } }
                }
            }
        }
        if (previous != null) {
            val resume = Button(this).apply { text = "返回已配對助理"; setOnClickListener { openAssistant(previous) } }
            val revoke = Button(this).apply { text = "停用裝置並解除配對"; setOnClickListener {
                busy(true); revoke(previous, status) { if (active()) busy(false) }
            } }
            controls.add(resume); controls.add(revoke)
            column.addView(resume); column.addView(revoke)
        }
        column.addView(TextView(this).apply {
            text = "首次使用：管理者依 backend README 產生配對碼。\n管理金鑰不輸入手機。檢查連線不會消耗配對碼。\n已配對但登入失敗時，使用「返回已配對助理」重試。"; textSize = 14f; setPadding(0, dp(22), 0, 0)
        })
        setContentView(ScrollView(this).apply { addView(column); applySystemInsets(this) })
    }
    private fun openAssistant(credential: DeviceCredential) {
        val api: NativeApiClient
        try { api = NativeApiClient(credential.origin, credential.token) }
        catch (_: Exception) { showSetup(); return }
        ++screenVersion
        ++sessionVersion
        bridge?.cancelRecording("navigation")
        currentCredential = credential
        NativeConfirmation.cancelForActivity(this)
        receipts = ExecutionReceiptStore(this, "${api.origin}|${credential.deviceId}")
        webView?.destroy()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(247,249,246)) }
        applySystemInsets(root)
        val toolbar = LinearLayout(this)
        toolbar.addView(Button(this).apply {
            text = "設定"; setOnClickListener { if (bridge?.isBusy() == true) toast("請先完成當前操作") else showSetup() }
        }, LinearLayout.LayoutParams(0, dp(52), 1f))
        toolbar.addView(Button(this).apply { text = "同步"; setOnClickListener {
            if (bridge?.isBusy() == true) { toast("請先完成當前操作"); return@setOnClickListener }
            toast("重新建立網頁登入並同步已保存結果…")
            refreshSession(api, {
                worker.execute {
                    val result = bridge?.syncSavedResults()
                    runOnUiThread {
                        webView?.reload()
                        toast("已同步 ${result?.first ?: 0} 筆；未同步 ${result?.second ?: 0} 筆。狀態不確定 ${receipts.uncertainCount()} 筆。")
                    }
                }
            }, { error -> toast(ConnectionDiagnostics.describe(error, ConnectionPhase.SESSION_REQUEST, api.origin)) })
        } }, LinearLayout.LayoutParams(0, dp(52), 1f))
        root.addView(toolbar)
        val view = WebView(this)
        webView = view
        view.setBackgroundColor(Color.rgb(247,249,246))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
        }
        WebView.setWebContentsDebuggingEnabled(false)
        CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(view, false) }
        val trusted = TrustedWebViewClient(this, api.origin) { bridge?.cancelRecording("navigation") }
        view.webViewClient = trusted
        view.webChromeClient = object : WebChromeClient() {
            private val pendingAudio = mutableSetOf<PermissionRequest>()
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (!trusted.trusted(request.origin) || request.resources.any { it != PermissionRequest.RESOURCE_AUDIO_CAPTURE }) { request.deny(); return@runOnUiThread }
                    pendingAudio.add(request)
                    permissions.request(arrayOf(android.Manifest.permission.RECORD_AUDIO)) { granted ->
                        if (pendingAudio.remove(request)) {
                            try {
                                if (granted && trusted.trusted(Uri.parse(view.url ?: ""))) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
                            } catch (_: Exception) { }
                        }
                    }
                }
            }
            override fun onPermissionRequestCanceled(request: PermissionRequest) { pendingAudio.remove(request) }
            override fun onShowFileChooser(web: WebView, callback: ValueCallback<Array<Uri>>, parameters: FileChooserParams): Boolean {
                if (!trusted.trusted(Uri.parse(web.url ?: ""))) { callback.onReceiveValue(null); return true }
                fileCallback?.onReceiveValue(null); fileCallback = callback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("audio/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                return try { startActivityForResult(intent, documentRequest); true }
                catch (_: Exception) { fileCallback?.onReceiveValue(null); fileCallback = null; toast("沒有可選擇音訊的檔案 App"); true }
            }
        }
        val dispatcher = ActionDispatcher(this, permissions, worker)
        val controller = BridgeController(this, view, api, dispatcher, receipts, worker, permissions,
            { foreground && currentCredential === credential && webView === view &&
                trusted.trusted(Uri.parse(view.url ?: "")) && isCurrentActivity() },
            { ready, failed -> refreshSession(api, ready, failed) },
            { ready, failed -> worker.execute {
                try {
                    api.call("POST", "/v1/auth/revoke-device")
                    runOnUiThread {
                        if (!isCurrentActivity() || currentCredential !== credential || webView !== view) return@runOnUiThread
                        val cleared = runCatching { if (credentials.load() == credential) credentials.clear() }.isSuccess
                        ++sessionVersion
                        if (cleared) ready() else failed(ApiException(0, "credential_clear_failed", "後端已停用裝置，但手機憑證未能移除。請重新配對。"))
                        queueCookieMutation({ isCurrentActivity() && currentCredential === credential && webView === view }) { done ->
                            CookieManager.getInstance().removeAllCookies {
                                if (isCurrentActivity() && currentCredential === credential && webView === view) {
                                    CookieManager.getInstance().flush(); showSetup()
                                }
                                done()
                            }
                        }
                    }
                } catch (error: Exception) { runOnUiThread {
                    if (isCurrentActivity() && currentCredential === credential && webView === view) failed(error)
                } }
            } })
        bridge = controller
        try { controller.install() } catch (_: Exception) {
            view.destroy(); webView = null
            toast("請更新 Android System WebView 後再使用手機橋接")
            showSetup(); return
        }
        root.addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        refreshSession(api, { if (webView === view) view.loadUrl("${api.origin}/") }, { error ->
            if (webView === view) showSetup(ConnectionDiagnostics.describe(error, ConnectionPhase.SESSION_REQUEST, api.origin) +
                "\n裝置憑證仍已保存；連線恢復後按「返回已配對助理」重試，無需再使用配對碼。")
        })
    }
    private fun refreshSession(api: NativeApiClient, ready: () -> Unit, failed: (Exception) -> Unit) {
        val expectedScreen = screenVersion
        val expectedSession = ++sessionVersion
        val expectedView = webView
        val expectedCredential = currentCredential
        fun current(): Boolean = isCurrentActivity() && screenVersion == expectedScreen &&
            sessionVersion == expectedSession && webView === expectedView && currentCredential === expectedCredential &&
            expectedCredential?.origin == api.origin
        worker.execute {
            try {
                val response = api.session()
                if (response.first.optString("device_id") != expectedCredential?.deviceId)
                    throw ApiException(0, "session_identity_mismatch", "網頁登入與已配對裝置身分不一致")
                val cookies = response.second.filter { it.startsWith("local_assistant_session=") }
                if (cookies.size != 1 || !cookies[0].contains("httponly", true) || !cookies[0].contains("secure", true))
                    throw ApiException(0, "session_cookie_invalid", "登入 Cookie 不符合安全要求")
                runOnUiThread {
                    if (!current()) return@runOnUiThread
                    // Serialize asynchronous CookieManager writes. An old account's in-flight
                    // installation must finish before the new account can load its page.
                    queueCookieMutation(::current) { done ->
                        CookieManager.getInstance().setCookie("${api.origin}/", cookies[0]) { accepted ->
                            if (current()) {
                                if (accepted) { CookieManager.getInstance().flush(); ready() }
                                else failed(ConnectionFailure(ConnectionPhase.SESSION_COOKIE, IllegalStateException("Cookie rejected"), api.origin))
                            }
                            done()
                        }
                    }
                }
            } catch (error: Exception) { runOnUiThread { if (current()) failed(ConnectionFailure(ConnectionPhase.SESSION_REQUEST, error, api.origin)) } }
        }
    }
    private fun revoke(credential: DeviceCredential, status: TextView, finished: () -> Unit) {
        val expectedScreen = screenVersion
        fun current() = isCurrentActivity() && screenVersion == expectedScreen && currentCredential == null
        AlertDialog.Builder(this).setTitle("停用這台裝置？")
            .setMessage("將通知中樞撤銷存取權，並移除本機配對憑證。手機記事本 App 的記事不受影響。")
            .setPositiveButton("停用") { _, _ -> worker.execute {
                try {
                    NativeApiClient(credential.origin, credential.token).call("POST", "/v1/auth/revoke-device")
                    runOnUiThread {
                        if (!current()) return@runOnUiThread
                        val cleared = runCatching { if (credentials.load() == credential) credentials.clear() }.isSuccess
                        ++sessionVersion
                        queueCookieMutation(::current) { done ->
                            CookieManager.getInstance().removeAllCookies {
                                if (current()) {
                                    CookieManager.getInstance().flush()
                                    showSetup(if (cleared) "" else "後端已停用裝置，但手機憑證未能移除。請重新配對。")
                                }
                                done()
                            }
                        }
                    }
                } catch (_: Exception) { runOnUiThread {
                    if (current()) { status.text = "無法通知中樞停用，配對憑證已保留。請恢復連線後再試。"; finished() }
                } }
            } }.setNegativeButton("取消") { _, _ -> finished() }.setOnCancelListener { finished() }.show()
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (!this.permissions.onRequestPermissionsResult(requestCode, permissions, grantResults))
            super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }
    @Deprecated("Legacy Activity API for dependency-light PoC")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == documentRequest) {
            val uri = if (resultCode == RESULT_OK) data?.data?.takeIf { it.scheme == "content" } else null
            fileCallback?.onReceiveValue(uri?.let { arrayOf(it) }); fileCallback = null
        }
    }
    @Deprecated("Legacy Activity API")
    override fun onBackPressed() {
        val view = webView
        if (view?.canGoBack() == true) view.goBack() else super.onBackPressed()
    }
    override fun onResume() {
        super.onResume()
        foreground = true
        if (APP_ACTIVITY_VERSION.get() != activityVersion) {
            // An older Activity may return from the Android back stack after another
            // instance paired a different account. Restore only the current saved identity.
            activityVersion = APP_ACTIVITY_VERSION.incrementAndGet()
            val saved = runCatching { credentials.load() }.getOrNull()
            if (saved == null) showSetup() else openAssistant(saved)
        }
    }
    override fun onStop() {
        foreground = false
        NativeConfirmation.cancelForActivity(this)
        bridge?.cancelRecording("background")
        super.onStop()
    }
    override fun onDestroy() {
        ++screenVersion
        ++sessionVersion
        APP_ACTIVITY_VERSION.compareAndSet(activityVersion, activityVersion + 1)
        foreground = false
        NativeConfirmation.cancelForActivity(this)
        bridge?.cancelRecording("background")
        fileCallback?.onReceiveValue(null); fileCallback = null
        webView?.destroy(); webView = null
        super.onDestroy()
    }
    private fun isCurrentActivity() = APP_ACTIVITY_VERSION.get() == activityVersion && !isFinishing && !isDestroyed
    private fun queueCookieMutation(current: () -> Boolean, perform: (done: () -> Unit) -> Unit) {
        val operation = operation@{
            if (!current()) return@operation
            cookieInstallRunning = true
            var completed = false
            val done = {
                if (!completed) {
                    completed = true
                    cookieInstallRunning = false
                    val queued = pendingCookieInstall
                    pendingCookieInstall = null
                    queued?.invoke()
                }
                Unit
            }
            try { perform(done) } catch (_: Exception) { done() }
        }
        if (cookieInstallRunning) pendingCookieInstall = operation else operation()
    }
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()
    @Suppress("DEPRECATION")
    private fun applySystemInsets(view: View) {
        view.setOnApplyWindowInsetsListener { target, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                target.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            } else target.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
    }
    private fun toast(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
}
