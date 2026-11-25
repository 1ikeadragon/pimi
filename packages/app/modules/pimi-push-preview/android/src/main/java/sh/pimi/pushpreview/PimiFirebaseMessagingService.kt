package sh.pimi.pushpreview

import android.app.KeyguardManager
import android.os.Bundle
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

/**
 * FCM entry point, ahead of expo-notifications' own service (which it extends). Data-only pushes
 * carrying a sealed preview are decrypted here and handed to Expo's presenter as an ordinary
 * title/message notification; every other message goes through untouched. A preview that fails
 * to open still posts, with the generic text, so a failure never drops a notification.
 */
class PimiFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val enc = message.data["enc"]
    if (enc == null) {
      super.onMessageReceived(message)
      return
    }
    // Each step falls through to a plainer one; the last always yields a presentable message, so
    // a preview problem can never drop the notification.
    val rewritten =
      runCatching { withPreview(message, enc) }.getOrNull()
        ?: runCatching { genericFallback(message) }.getOrNull()
        ?: minimalFallback(message)
    super.onMessageReceived(rewritten)
  }

  private fun withPreview(message: RemoteMessage, enc: String): RemoteMessage {
    val target = JSONObject(message.data["body"] ?: "")
    val serverId = target.optString("serverId")
    val agentId = target.optString("agentId")
    val reason = target.optString("reason")
    val store = PreviewKeyStore(this)
    // The setting wins over any key still on disk: with previews off the message is never opened.
    if (!store.previewsEnabled) return build(message, DEFAULT_TITLE, genericBody(reason))
    val preview =
      PreviewCrypto.open(store.key(serverId), enc, "pimi-push-preview/1|$reason|$agentId")
        ?.takeIf { store.acceptTs(serverId, it.ts) }
    val locked = store.hideWhenLocked && (getSystemService(KeyguardManager::class.java)?.isDeviceLocked ?: true)
    val showPreview = preview != null && !locked
    // A locked phone still shows the chat name, only the message is withheld.
    return build(
      message,
      title = preview?.title?.ifEmpty { null } ?: DEFAULT_TITLE,
      body = if (showPreview) preview!!.body else genericBody(reason),
    )
  }

  private fun genericFallback(message: RemoteMessage): RemoteMessage {
    val reason = runCatching { JSONObject(message.data["body"] ?: "").optString("reason") }.getOrDefault("")
    return build(message, title = DEFAULT_TITLE, body = genericBody(reason))
  }

  // Rebuilt from the original intent extras so the message id, sent time and priority survive:
  // Expo derives its identifier, tap replay and acknowledgement from them.
  private fun build(message: RemoteMessage, title: String, body: String): RemoteMessage {
    val extras = Bundle(message.toIntent().extras)
    extras.remove("enc")
    extras.putString("title", title)
    extras.putString("message", body)
    return RemoteMessage(extras)
  }

  // Last resort when the intent round trip fails: same data, built field by field.
  private fun minimalFallback(message: RemoteMessage): RemoteMessage {
    val reason = runCatching { JSONObject(message.data["body"] ?: "").optString("reason") }.getOrDefault("")
    val data = message.data.toMutableMap()
    data.remove("enc")
    data["title"] = DEFAULT_TITLE
    data["message"] = genericBody(reason)
    return RemoteMessage.Builder("pimi@fcm.googleapis.com")
      .setMessageId(message.messageId ?: "")
      .setData(data)
      .build()
  }

  private fun genericBody(reason: String) =
    if (reason == "permission") "An agent needs your approval." else "An agent finished."

  private companion object {
    const val DEFAULT_TITLE = "Pimi"
  }
}
