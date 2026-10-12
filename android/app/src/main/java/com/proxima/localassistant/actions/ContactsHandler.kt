package com.proxima.localassistant.actions

import android.Manifest
import android.app.Activity
import android.provider.ContactsContract.CommonDataKinds.Phone
import com.proxima.localassistant.permissions.PermissionController
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Executor

class ContactsHandler(
    private val activity: Activity,
    private val permissions: PermissionController,
    private val worker: Executor
) {
    fun execute(payload: JSONObject, callback: (JSONObject) -> Unit) {
        val query = payload.getString("query").trim()
        require(query.isNotEmpty() && query.length <= 100)
        permissions.request(arrayOf(Manifest.permission.READ_CONTACTS)) { granted ->
            if (!granted) callback(ActionDispatcher.receipt("permission_denied", "通訊錄權限未取得"))
            else worker.execute {
                try { callback(ActionDispatcher.receipt("completed", "聯絡人查詢完成", lookup(query))) }
                catch (_: SecurityException) { callback(ActionDispatcher.receipt("permission_denied", "通訊錄權限已撤回")) }
                catch (_: Exception) { callback(ActionDispatcher.receipt("failed", "無法查詢手機通訊錄")) }
            }
        }
    }

    private fun lookup(query: String): JSONObject {
        val escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        val digitQuery = if (query.all { it in '0'..'9' || it in "+ ()-." }) query.filter { it in '0'..'9' } else ""
        val clauses = mutableListOf("${Phone.DISPLAY_NAME} LIKE ? ESCAPE '\\'")
        val args = mutableListOf("%$escaped%")
        if (digitQuery.isNotEmpty()) {
            clauses += "${Phone.NORMALIZED_NUMBER} LIKE ?"
            args += "%$digitQuery%"
            clauses += "${Phone.NUMBER} LIKE ? ESCAPE '\\'"
            args += "%$escaped%"
        }
        val contacts = JSONArray()
        val seen = HashSet<String>()
        activity.contentResolver.query(
            Phone.CONTENT_URI,
            arrayOf(Phone.CONTACT_ID, Phone.DISPLAY_NAME, Phone.NUMBER),
            clauses.joinToString(" OR "), args.toTypedArray(), "${Phone.DISPLAY_NAME} ASC"
        )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(Phone.CONTACT_ID)
            val nameColumn = cursor.getColumnIndexOrThrow(Phone.DISPLAY_NAME)
            val numberColumn = cursor.getColumnIndexOrThrow(Phone.NUMBER)
            while (contacts.length() < 20 && cursor.moveToNext()) {
                val id = cursor.getString(idColumn)
                val name = cursor.getString(nameColumn).orEmpty()
                val raw = cursor.getString(numberColumn).orEmpty()
                // Extensions, pauses, service codes and vanity numbers need separate handling.
                // Never silently merge an extension into a different telephone number.
                if (!raw.trim().matches(Regex("^\\+?[0-9][0-9 ()\\-.]{1,60}[0-9]$"))) continue
                val number = raw.filter { it in '0'..'9' || it == '+' }
                if (!number.matches(Regex("^\\+?[0-9]{3,31}$"))) continue
                val nameMatches = name.lowercase(Locale.ROOT).contains(query.lowercase(Locale.ROOT))
                val phoneMatches = digitQuery.isNotEmpty() && number.filter { it.isDigit() }.contains(digitQuery)
                if (!nameMatches && !phoneMatches) continue
                if (!seen.add("$id:$number")) continue
                contacts.put(JSONObject().put("name", name.take(100)).put("phone_number", number)
                    .put("contact_id", id.take(100)))
            }
        }
        return JSONObject().put("contacts", contacts)
    }
}
