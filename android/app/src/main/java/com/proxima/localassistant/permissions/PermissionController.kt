package com.proxima.localassistant.permissions

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper

/** Requests only permissions needed for the current user operation. */
class PermissionController(private val activity: Activity) {
    private var pending: ((Boolean) -> Unit)? = null
    private var requested: Array<String> = emptyArray()

    fun request(permissions: Array<String>, callback: (Boolean) -> Unit) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { request(permissions, callback) }
            return
        }
        val missing = permissions.distinct().filter {
            activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }.toTypedArray()
        if (missing.isEmpty()) { callback(true); return }
        if (pending != null || activity.isFinishing || activity.isDestroyed) { callback(false); return }
        pending = callback
        requested = missing
        activity.requestPermissions(missing, REQUEST_CODE)
    }

    fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray): Boolean {
        if (requestCode != REQUEST_CODE) return false
        val granted = requested.isNotEmpty() && requested.all {
            activity.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }
        val callback = pending
        pending = null
        requested = emptyArray()
        callback?.invoke(granted)
        return true
    }

    companion object { const val REQUEST_CODE = 3201 }
}
