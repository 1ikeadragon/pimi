package sh.pimi.pushpreview

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Preview keys, one per host. Each is wrapped at rest by a non-exportable Android Keystore key.
 * The wrapping key deliberately has no user-authentication or unlocked-device requirement: the FCM
 * service must decrypt while the phone is locked.
 */
class PreviewKeyStore(context: Context) {
  private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Synchronized
  fun getOrCreateKey(serverId: String): String {
    key(serverId)?.let { return encode(it) }
    val fresh = ByteArray(32).also { SecureRandom().nextBytes(it) }
    prefs
      .edit()
      .putString("$KEY_PREFIX$serverId", Base64.encodeToString(wrap(fresh), Base64.NO_WRAP))
      // A new key starts a new timestamp history.
      .remove("$TS_PREFIX$serverId")
      .apply()
    return encode(fresh)
  }

  /** The raw key, or null when none exists or the Keystore cannot unwrap it (entry is dropped). */
  @Synchronized
  fun key(serverId: String): ByteArray? {
    val stored = prefs.getString("$KEY_PREFIX$serverId", null) ?: return null
    return try {
      unwrap(Base64.decode(stored, Base64.NO_WRAP))
    } catch (_: Exception) {
      deleteKey(serverId)
      null
    }
  }

  @Synchronized
  fun deleteKey(serverId: String) {
    prefs.edit().remove("$KEY_PREFIX$serverId").remove("$TS_PREFIX$serverId").apply()
  }

  /** True and stored when ts is newer than every accepted one for this host; replays fail. */
  @Synchronized
  fun acceptTs(serverId: String, ts: Long): Boolean {
    if (ts <= prefs.getLong("$TS_PREFIX$serverId", 0L)) return false
    prefs.edit().putLong("$TS_PREFIX$serverId", ts).apply()
    return true
  }

  var hideWhenLocked: Boolean
    get() = prefs.getBoolean(HIDE_WHEN_LOCKED, false)
    @Synchronized set(value) {
      prefs.edit().putBoolean(HIDE_WHEN_LOCKED, value).apply()
    }

  private fun encode(key: ByteArray) =
    Base64.encodeToString(key, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

  private fun wrappingKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  private fun wrap(raw: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
    return cipher.iv + cipher.doFinal(raw)
  }

  private fun unwrap(blob: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, blob, 0, IV_BYTES))
    return cipher.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
  }

  companion object {
    private const val PREFS = "pimi_push_preview"
    private const val ALIAS = "pimi-push-preview-v1"
    private const val KEY_PREFIX = "key."
    private const val TS_PREFIX = "ts."
    private const val HIDE_WHEN_LOCKED = "hideWhenLocked"
    private const val IV_BYTES = 12
  }
}
