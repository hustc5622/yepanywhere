package com.yepanywhere.mobile.local

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

object YepNativeNotifier {
  const val CHANNEL_ID = "yep_anywhere_agent_attention"
  private const val RUNNING_CHANNEL_ID = "yep_anywhere_agent_running"
  private const val TAG = "YepNativePush"
  private const val NOTIFICATION_ID = 1001
  private const val RUNNING_NOTIFICATION_ID = 1002
  private const val RUNNING_TAG_PREFIX = "session-running-"

  data class SessionNotification(
    val sessionId: String,
    val projectId: String,
    val projectName: String,
    val sessionTitle: String,
    val updatedAt: String?,
    val pendingInputType: String? = null,
    val summary: String? = null,
    val hasUnread: Boolean = false,
    /** Pending request id; enables Approve/Deny actions on the notification. */
    val pendingRequestId: String? = null,
  ) {
    val path: String
      get() =
        "/projects/${Uri.encode(projectId)}/sessions/${Uri.encode(sessionId)}"
  }

  fun ensureNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Agent attention",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = "Notifications for sessions waiting for input"
        setShowBadge(true)
      }
      manager.createNotificationChannel(channel)
    }

    if (manager.getNotificationChannel(RUNNING_CHANNEL_ID) == null) {
      val channel = NotificationChannel(
        RUNNING_CHANNEL_ID,
        "Agent running",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Persistent status for running sessions"
        setShowBadge(false)
        setSound(null, null)
      }
      manager.createNotificationChannel(channel)
    }
  }

  fun showPendingInput(
    context: Context,
    session: SessionNotification,
    badgeCount: Int? = null,
  ) {
    val body = pendingInputBody(session.pendingInputType, session.summary)
    // Approve/Deny only applies to tool approvals with a known request id;
    // questions need the full option UI in the app.
    val approvalRequestId = pendingApprovalRequestId(
      session.pendingInputType,
      session.pendingRequestId,
    )
    showNotification(
      context = context,
      tag = "session-${session.sessionId}",
      notificationId = NOTIFICATION_ID,
      channelId = CHANNEL_ID,
      title = displaySessionTitle(session),
      body = body,
      subText = session.projectName.ifBlank { "Yep Anywhere" },
      path = session.path,
      autoCancel = false,
      silent = false,
      ongoing = true,
      shortCriticalText = "Input",
      miuiBusiness = "agent_waiting",
      badgeCount = badgeCount,
      approvalAction = approvalRequestId?.let {
        ApprovalActionInfo(
          sessionId = session.sessionId,
          projectId = session.projectId,
          requestId = it,
        )
      },
    )
  }

  internal fun pendingInputBody(inputType: String?, summary: String?): String {
    if (inputType == "user-question") {
      return "Question waiting — open Yep to answer"
    }
    val inputLabel = when (inputType) {
      "tool-approval" -> "Approval needed"
      else -> "Waiting for input"
    }
    val detail = summary?.takeIf { it.isNotBlank() }
    return if (detail == null) inputLabel else "$inputLabel · $detail"
  }

  internal fun pendingApprovalRequestId(
    inputType: String?,
    requestId: String?,
  ): String? = requestId?.takeIf {
    it.isNotBlank() && inputType == "tool-approval"
  }

  /** Everything needed to reply to a pending approval from a notification. */
  data class ApprovalActionInfo(
    val sessionId: String,
    val projectId: String?,
    val requestId: String,
  )

  fun showRunning(context: Context, session: SessionNotification) {
    showNotification(
      context = context,
      tag = "$RUNNING_TAG_PREFIX${session.sessionId}",
      notificationId = RUNNING_NOTIFICATION_ID,
      channelId = RUNNING_CHANNEL_ID,
      title = displaySessionTitle(session),
      body = "Running",
      subText = session.projectName.ifBlank { "Yep Anywhere" },
      path = session.path,
      autoCancel = false,
      silent = true,
      ongoing = true,
      shortCriticalText = "Running",
      miuiBusiness = "agent_running",
      badgeCount = null,
    )
  }

  fun showSessionHalted(
    context: Context,
    sessionId: String,
    projectId: String?,
    projectName: String?,
    sessionTitle: String?,
    reason: String?,
    badgeCount: Int? = null,
  ) {
    val body = when (reason) {
      "completed" -> "Completed"
      "error" -> "Stopped with an error"
      "idle" -> "Stopped"
      else -> "Finished"
    }
    showNotification(
      context = context,
      tag = "session-halted-$sessionId",
      notificationId = NOTIFICATION_ID,
      channelId = CHANNEL_ID,
      title = sessionTitle?.takeIf { it.isNotBlank() } ?: "Session finished",
      body = body,
      subText = projectName?.takeIf { it.isNotBlank() } ?: "Yep Anywhere",
      path = sessionPath(projectId, sessionId),
      autoCancel = true,
      silent = false,
      ongoing = false,
      shortCriticalText = null,
      miuiBusiness = "agent_done",
      badgeCount = badgeCount,
    )
    cancelRunning(context, sessionId)
  }

  fun showTest(
    context: Context,
    message: String,
    urgency: String?,
  ) {
    showNotification(
      context = context,
      tag = "test",
      notificationId = NOTIFICATION_ID,
      channelId = CHANNEL_ID,
      title = "Yep Anywhere",
      body = message.ifBlank { "Test notification" },
      subText = null,
      path = "/",
      autoCancel = urgency != "persistent",
      silent = urgency == "silent",
      ongoing = urgency == "persistent",
      shortCriticalText = if (urgency == "persistent") "Test" else null,
      miuiBusiness = "agent_test",
      badgeCount = null,
    )
  }

  /**
   * Replace a pending-input notification with a tap-to-open fallback after a
   * failed or unsafe notification-action reply.
   */
  fun showApprovalFallback(
    context: Context,
    sessionId: String,
    projectId: String?,
    message: String,
  ) {
    showNotification(
      context = context,
      tag = "session-$sessionId",
      notificationId = NOTIFICATION_ID,
      channelId = CHANNEL_ID,
      title = "Approval needs attention",
      body = message,
      subText = null,
      path = sessionPath(projectId, sessionId),
      autoCancel = true,
      silent = false,
      ongoing = false,
      shortCriticalText = null,
      miuiBusiness = "agent_waiting",
      badgeCount = null,
    )
  }

  fun syncBadge(context: Context, count: Int) {
    YepLauncherBadge.sync(context, count)
  }

  fun cancelSession(context: Context, sessionId: String?) {
    if (sessionId.isNullOrBlank()) return
    val manager = NotificationManagerCompat.from(context)
    manager.cancel("session-$sessionId", NOTIFICATION_ID)
    manager.cancel("session-halted-$sessionId", NOTIFICATION_ID)
    cancelRunning(context, sessionId)
    Log.i(TAG, "cancelSession: sessionId=$sessionId")
  }

  fun cancelRunning(context: Context, sessionId: String?) {
    if (sessionId.isNullOrBlank()) return
    NotificationManagerCompat.from(context)
      .cancel("$RUNNING_TAG_PREFIX$sessionId", RUNNING_NOTIFICATION_ID)
  }

  fun cancelStaleRunning(context: Context, visibleRunningSessionIds: Set<String>) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return

    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (notification in manager.activeNotifications) {
      if (notification.id != RUNNING_NOTIFICATION_ID) continue

      val tag = notification.tag ?: continue
      if (!tag.startsWith(RUNNING_TAG_PREFIX)) continue

      val sessionId = tag.removePrefix(RUNNING_TAG_PREFIX)
      if (visibleRunningSessionIds.contains(sessionId)) continue

      NotificationManagerCompat.from(context).cancel(tag, RUNNING_NOTIFICATION_ID)
      Log.i(TAG, "cancelStaleRunning: sessionId=$sessionId")
    }
  }

  @SuppressLint("MissingPermission")
  private fun showNotification(
    context: Context,
    tag: String,
    notificationId: Int,
    channelId: String,
    title: String,
    body: String,
    subText: String?,
    path: String,
    autoCancel: Boolean,
    silent: Boolean,
    ongoing: Boolean,
    shortCriticalText: String?,
    miuiBusiness: String,
    badgeCount: Int?,
    approvalAction: ApprovalActionInfo? = null,
  ) {
    ensureNotificationChannel(context)

    if (!canPostNotifications(context)) {
      YepLog.w("showNotification", "notification permission not granted tag=$tag")
      return
    }

    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or
        Intent.FLAG_ACTIVITY_SINGLE_TOP
      putExtra(MainActivity.EXTRA_NOTIFICATION_PATH, path)
    }
    val pendingIntent = PendingIntent.getActivity(
      context,
      path.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, channelId)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }

    builder
      .setSmallIcon(R.drawable.ic_stat_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setContentIntent(pendingIntent)
      .setAutoCancel(autoCancel)
      .setOngoing(ongoing)
      .setOnlyAlertOnce(ongoing)
      .setShowWhen(true)
      .setCategory(Notification.CATEGORY_STATUS)
      .setPriority(Notification.PRIORITY_HIGH)
      .setNumber(badgeCount ?: 0)

    if (!subText.isNullOrBlank()) {
      builder.setSubText(subText)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      builder.setBadgeIconType(Notification.BADGE_ICON_SMALL)
    }

    if (silent) {
      @Suppress("DEPRECATION")
      builder.setDefaults(0)
      builder.setSound(null)
    }

    if (Build.VERSION.SDK_INT >= 36 && ongoing && !shortCriticalText.isNullOrBlank()) {
      builder.setShortCriticalText(shortCriticalText.take(7))
    }

    if (approvalAction != null) {
      builder.addAction(approvalActionButton(context, approvalAction, true))
      builder.addAction(approvalActionButton(context, approvalAction, false))
    }

    val notification = builder.build()
    notification.extras.putString(
      "miui.focus.param",
      buildMiuiFocusParam(
        title = title,
        body = body,
        ticker = shortCriticalText ?: title,
        business = miuiBusiness,
        updatable = ongoing,
      ),
    )

    if (Build.VERSION.SDK_INT >= 36 && ongoing) {
      notification.flags = notification.flags or Notification.FLAG_PROMOTED_ONGOING
    }

    try {
      NotificationManagerCompat.from(context).notify(tag, notificationId, notification)
      YepLog.i(
        "showNotification",
        "posted tag=$tag id=$notificationId ongoing=$ongoing miuiBusiness=$miuiBusiness",
      )
    } catch (error: SecurityException) {
      YepLog.e("showNotification", "missing notification permission", error)
    } catch (error: RuntimeException) {
      YepLog.e("showNotification", "failed", error)
    }
  }

  internal fun canPostNotifications(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }
    return ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED &&
      NotificationManagerCompat.from(context).areNotificationsEnabled()
  }

  private fun buildMiuiFocusParam(
    title: String,
    body: String,
    ticker: String,
    business: String,
    updatable: Boolean,
  ): String {
    val baseInfo = JSONObject()
      .put("title", title.take(24))
      .put("content", body.take(72))

    val paramV2 = JSONObject()
      .put("protocol", 1)
      .put("business", business)
      .put("enableFloat", true)
      .put("updatable", updatable)
      .put("ticker", ticker.take(16))
      .put("baseInfo", baseInfo)
      .put("sequence", System.currentTimeMillis())

    return JSONObject()
      .put("param_v2", paramV2)
      .toString()
  }

  private fun approvalActionButton(
    context: Context,
    info: ApprovalActionInfo,
    approve: Boolean,
  ): Notification.Action {
    val action = if (approve) {
      YepApprovalActionReceiver.ACTION_APPROVE
    } else {
      YepApprovalActionReceiver.ACTION_DENY
    }
    val intent = Intent(context, YepApprovalActionReceiver::class.java).apply {
      putExtra(YepApprovalActionReceiver.EXTRA_ACTION, action)
      putExtra(YepApprovalActionReceiver.EXTRA_SESSION_ID, info.sessionId)
      putExtra(YepApprovalActionReceiver.EXTRA_REQUEST_ID, info.requestId)
      putExtra(YepApprovalActionReceiver.EXTRA_PROJECT_ID, info.projectId)
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      // Distinct request codes per session+request+button so approve/deny
      // and concurrent sessions never collapse into one PendingIntent.
      "$action:${info.sessionId}:${info.requestId}".hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return Notification.Action.Builder(
      null,
      if (approve) "Approve" else "Deny",
      pendingIntent,
    ).build()
  }

  private fun sessionPath(projectId: String?, sessionId: String): String {
    if (projectId.isNullOrBlank()) return "/"
    return "/projects/${Uri.encode(projectId)}/sessions/${Uri.encode(sessionId)}"
  }

  private fun displaySessionTitle(session: SessionNotification): String {
    return session.sessionTitle.takeIf { it.isNotBlank() } ?: "Untitled session"
  }
}
