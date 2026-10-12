package com.proxima.localassistant.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** AES-GCM key remains in Android Keystore. No plaintext token or receipt files. */
class EncryptedFile(context: Context, name: String) {
    private val file = AtomicFile(File(context.noBackupFilesDir, name))
    private val alias = "local-assistant-aes-v1"
    private fun key(): SecretKey = synchronized(KEY_LOCK) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null) as? SecretKey
        if (existing != null) existing else KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    companion object { private val KEY_LOCK = Any(); private val FILE_LOCK = Any() }
    fun read(): String? = synchronized(FILE_LOCK) {
        if (!file.baseFile.exists()) return null
        val buffer = ByteBuffer.wrap(file.readFully())
        require(buffer.remaining() >= 30 && buffer.get().toInt() == 1) { "Invalid encrypted file" }
        val ivSize = buffer.get().toInt() and 255
        require(ivSize == 12 && buffer.remaining() >= ivSize + 16)
        val iv = ByteArray(ivSize).also { buffer.get(it) }
        val ciphertext = ByteArray(buffer.remaining()).also { buffer.get(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        cipher.updateAAD(file.baseFile.name.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }
    fun write(value: String): Unit = synchronized(FILE_LOCK) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(file.baseFile.name.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val bytes = ByteBuffer.allocate(2 + cipher.iv.size + encrypted.size)
            .put(1.toByte()).put(cipher.iv.size.toByte()).put(cipher.iv).put(encrypted).array()
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
    fun delete(): Unit = synchronized(FILE_LOCK) { file.delete() }
}
