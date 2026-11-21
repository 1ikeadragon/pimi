package sh.pimi.pushpreview

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

class Preview(val title: String, val body: String, val ts: Long)

/** Opens the sealed previews the daemon builds in push-preview-seal.ts. Never logs inputs or outputs. */
object PreviewCrypto {
  private const val VERSION: Byte = 0x01
  private const val NONCE_BYTES = 12
  private const val TAG_BITS = 128
  private const val MIN_BYTES = 1 + NONCE_BYTES + 16
  private const val MAX_TITLE_CHARS = 80
  private const val MAX_BODY_CHARS = 300

  /** Returns null for any failure: wrong key, tampering, wrong reason or agent, bad version or JSON. */
  fun open(key: ByteArray?, enc: String, aad: String): Preview? {
    if (key == null || key.size != 32) return null
    return try {
      val sealed = Base64.getUrlDecoder().decode(enc)
      if (sealed.size < MIN_BYTES || sealed[0] != VERSION) return null
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(
        Cipher.DECRYPT_MODE,
        SecretKeySpec(key, "AES"),
        GCMParameterSpec(TAG_BITS, sealed, 1, NONCE_BYTES),
      )
      cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
      val plain = cipher.doFinal(sealed, 1 + NONCE_BYTES, sealed.size - 1 - NONCE_BYTES)
      val json = JSONObject(String(plain, Charsets.UTF_8))
      Preview(
        title = json.getString("title").take(MAX_TITLE_CHARS),
        body = json.getString("body").take(MAX_BODY_CHARS),
        ts = json.getLong("ts"),
      )
    } catch (_: Exception) {
      null
    }
  }
}
