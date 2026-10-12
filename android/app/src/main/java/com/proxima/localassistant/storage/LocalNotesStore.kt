package com.proxima.localassistant.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.time.Instant
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Note bodies + metadata are AES-256-GCM encrypted in app-private files. */
class LocalNotesStore(context: Context) {
    private val directory = File(context.filesDir, "encrypted_notes").apply {
        check(exists() || mkdirs())
    }

    @Synchronized fun save(payload: JSONObject): JSONObject {
        val id = payload.getString("note_id")
        val title = payload.getString("title")
        val content = payload.getString("content")
        require(id.length in 1..100 && title.length in 1..200 && content.length in 1..16000)
        val note = JSONObject().put("note_id", id).put("title", title).put("content", content)
            .put("saved_at", Instant.now().toString())
        if (payload.has("transcript") && !payload.isNull("transcript")) {
            val transcript = payload.getString("transcript")
            require(transcript.length <= 24000)
            note.put("transcript", transcript)
        }
        val file = noteFile(id)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(file.name.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(note.toString().toByteArray(Charsets.UTF_8))
        val bytes = byteArrayOf(1, cipher.iv.size.toByte()) + cipher.iv + encrypted
        val atomic = AtomicFile(file)
        val output = atomic.startWrite()
        try { output.write(bytes); atomic.finishWrite(output) }
        catch (error: Exception) { atomic.failWrite(output); throw error }
        return JSONObject(note.toString())
    }

    @Synchronized fun get(noteId: String): JSONObject? {
        require(noteId.length in 1..100)
        val file = noteFile(noteId)
        return if (file.exists()) read(file) else null
    }

    @Synchronized fun list(): List<JSONObject> = directory.listFiles { file -> file.name.endsWith(".enc") }
        .orEmpty().map { read(it) }.sortedByDescending { it.optString("saved_at") }

    private fun read(file: File): JSONObject {
        val bytes = AtomicFile(file).readFully()
        check(bytes.size > 30 && bytes[0].toInt() == 1)
        val ivLength = bytes[1].toInt() and 255
        check(ivLength == 12 && bytes.size > 2 + ivLength + 16)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(2, 2 + ivLength)))
        cipher.updateAAD(file.name.toByteArray(Charsets.UTF_8))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(2 + ivLength, bytes.size)), Charsets.UTF_8))
    }

    private fun noteFile(id: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        return File(directory, "$digest.enc")
    }

    private fun key(): SecretKey = synchronized(KEY_LOCK) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) existing else KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
            generateKey()
        }
    }

    companion object {
        private const val KEY_ALIAS = "com.proxima.localassistant.notes.v1"
        private val KEY_LOCK = Any()
    }
}
