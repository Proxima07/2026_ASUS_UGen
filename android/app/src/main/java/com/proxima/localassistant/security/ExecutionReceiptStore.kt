package com.proxima.localassistant.security

import android.content.Context
import org.json.JSONObject
import java.security.MessageDigest

/** A write-ahead guard: recovering an app crash never repeats a phone operation. */
class ExecutionReceiptStore(context: Context, scope: String) {
    companion object { private val LOCK = Any() }
    private val digest = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
    private val file = EncryptedFile(context, "execution-receipts-$digest.enc")
    private fun readAll(): JSONObject = file.read()?.let { JSONObject(it) } ?: JSONObject()
    fun contains(actionId: String): Boolean = synchronized(LOCK) { readAll().has(actionId) }
    fun preparing(actionId: String): Unit = synchronized(LOCK) {
        val items = readAll()
        require(!items.has(actionId)) { "Action already attempted" }
        items.put(actionId, JSONObject().put("action_id", actionId).put("phase", "preparing")
            .put("created_at", System.currentTimeMillis()))
        file.write(items.toString())
    }
    fun claimed(actionId: String, token: String): Unit = synchronized(LOCK) {
        val items = readAll()
        items.getJSONObject(actionId).put("execution_token", token).put("phase", "claimed")
        file.write(items.toString())
    }
    fun complete(actionId: String, state: String, result: JSONObject): Unit = synchronized(LOCK) {
        val items = readAll()
        items.getJSONObject(actionId).put("state", state).put("result", result).put("phase", "result_pending")
        file.write(items.toString())
    }
    fun markSynced(actionId: String): Unit = synchronized(LOCK) {
        val items = readAll()
        items.getJSONObject(actionId).put("phase", "synced")
        file.write(items.toString())
    }
    fun pendingResults(): List<JSONObject> = synchronized(LOCK) {
        val items = readAll()
        return items.keys().asSequence().map { items.getJSONObject(it) }
            .filter { it.optString("phase") == "result_pending" }.map { JSONObject(it.toString()) }.toList()
    }
    fun uncertainCount(): Int = synchronized(LOCK) {
        val items = readAll()
        return items.keys().asSequence().count { items.getJSONObject(it).optString("phase") in setOf("preparing", "claimed") }
    }
}
