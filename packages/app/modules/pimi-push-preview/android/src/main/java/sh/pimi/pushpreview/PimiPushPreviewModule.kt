package sh.pimi.pushpreview

import android.app.KeyguardManager
import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PimiPushPreviewModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("No context")

  private val store by lazy { PreviewKeyStore(context) }

  override fun definition() = ModuleDefinition {
    Name("PimiPushPreview")

    // The raw key is returned only so JS can register it with the daemon over the encrypted
    // session. Callers must not persist or log it.
    AsyncFunction("getOrCreateKey") { serverId: String -> store.getOrCreateKey(serverId) }
    AsyncFunction("deleteKey") { serverId: String -> store.deleteKey(serverId) }
    AsyncFunction("setHideWhenLocked") { value: Boolean -> store.hideWhenLocked = value }
    AsyncFunction("setPreviewsEnabled") { value: Boolean -> store.previewsEnabled = value }
    // The locked state is read here (not in the FCM service) for local notifications.
    Function("isDeviceLocked") {
      context.getSystemService(KeyguardManager::class.java)?.isDeviceLocked ?: false
    }
  }
}
