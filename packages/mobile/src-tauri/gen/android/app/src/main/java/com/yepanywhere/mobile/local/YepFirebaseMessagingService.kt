package com.yepanywhere.mobile.local

import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class YepFirebaseMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    YepLog.i(
      "fcm.onMessageReceived",
      "from=${message.from ?: "null"} messageId=${message.messageId ?: "null"} type=${data["type"] ?: "null"} keys=${data.keys.joinToString(",")}",
    )
    when (data["type"]) {
      "dismiss" -> YepNativeNotifier.cancelSession(this, data["sessionId"])
      "pending-input" -> showPendingInputNotification(data)
      "session-halted" -> showSessionHaltedNotification(data)
      "test" -> YepNativeNotifier.showTest(
        context = this,
        message = data["message"] ?: "Test notification",
        urgency = data["urgency"],
      )
      else -> YepLog.w("fcm.onMessageReceived", "unsupported type=${data["type"] ?: "null"}")
    }
  }

  override fun onNewToken(token: String) {
    super.onNewToken(token)
    YepLog.i("fcm.onNewToken", "tokenLength=${token.length}")
    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(PREF_FCM_TOKEN, token)
      .apply()
  }

  private fun showPendingInputNotification(data: Map<String, String>) {
    val session = sessionNotificationFromData(data) ?: return
    YepNativeNotifier.showPendingInput(this, session)
  }

  private fun showSessionHaltedNotification(data: Map<String, String>) {
    val sessionId = data["sessionId"] ?: return
    YepNativeNotifier.showSessionHalted(
      context = this,
      sessionId = sessionId,
      projectId = data["projectId"],
      projectName = data["projectName"],
      sessionTitle = data["sessionTitle"],
      reason = data["reason"],
    )
  }

  private fun sessionNotificationFromData(
    data: Map<String, String>,
  ): YepNativeNotifier.SessionNotification? {
    val sessionId = data["sessionId"]
    val projectId = data["projectId"]
    if (sessionId.isNullOrBlank() || projectId.isNullOrBlank()) return null

    val title =
      data["sessionTitle"]?.takeIf { it.isNotBlank() }
        ?: data["summary"]?.takeIf { it.isNotBlank() }
        ?: "Session"

    return YepNativeNotifier.SessionNotification(
      sessionId = sessionId,
      projectId = projectId,
      projectName = data["projectName"] ?: "Yep Anywhere",
      sessionTitle = title,
      updatedAt = data["timestamp"],
      pendingInputType = data["inputType"] ?: data["pendingInputType"],
      summary = data["summary"],
      pendingRequestId = data["requestId"]?.takeIf { it.isNotBlank() },
    )
  }

  companion object {
    private const val TAG = "YepNativePush"
    private const val PREFS_NAME = "yep_native_push"
    private const val PREF_FCM_TOKEN = "fcm_token"
  }
}
