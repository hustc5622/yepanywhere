package com.yepanywhere.mobile.local

import android.content.Context
import android.util.Log
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class YepSessionWatcher(private val context: Context) {
  private val appContext = context.applicationContext
  private val executor: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "YepSessionWatcher").apply { isDaemon = true }
    }
  private val notifiedNeedsAttention = mutableSetOf<String>()
  private val notifiedRunning = mutableSetOf<String>()
  private val notifiedUnread = mutableSetOf<String>()
  private val previouslyActive = mutableSetOf<String>()
  private var task: ScheduledFuture<*>? = null
  private var origin: String? = null

  @Synchronized
  fun start(serverOrigin: String) {
    val normalizedOrigin = normalizeOrigin(serverOrigin)
    if (normalizedOrigin == null) {
      YepLog.w("watcher.start", "ignored invalid origin=$serverOrigin")
      return
    }

    if (origin == normalizedOrigin && task?.isCancelled == false) {
      Log.d(TAG, "start: watcher already running origin=$normalizedOrigin")
      return
    }

    stopLocked(cancelNotifications = origin != null && origin != normalizedOrigin)
    origin = normalizedOrigin
    YepLog.i("watcher.start", "origin=$normalizedOrigin intervalMs=$POLL_INTERVAL_MS")
    task = executor.scheduleWithFixedDelay(
      { pollSafely(normalizedOrigin) },
      0,
      POLL_INTERVAL_MS,
      TimeUnit.MILLISECONDS,
    )
  }

  @Synchronized
  fun stop() {
    stopLocked(cancelNotifications = false)
    executor.shutdownNow()
  }

  @Synchronized
  private fun stopLocked(cancelNotifications: Boolean) {
    task?.cancel(true)
    task = null
    origin = null
    if (cancelNotifications) {
      val sessionIds = notifiedNeedsAttention + notifiedRunning
      for (sessionId in sessionIds) {
        YepNativeNotifier.cancelSession(appContext, sessionId)
      }
    }
    notifiedNeedsAttention.clear()
    notifiedRunning.clear()
    notifiedUnread.clear()
    previouslyActive.clear()
  }

  private fun pollSafely(serverOrigin: String) {
    try {
      poll(serverOrigin)
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (error: Throwable) {
      YepLog.e("watcher.poll", "failed", error)
    }
  }

  private fun poll(serverOrigin: String) {
    val inboxUrl = "$serverOrigin/yep/api/inbox"
    val response = getJson(inboxUrl)
    val needsAttention = parseSessions(response.optJSONArray("needsAttention"))
    val active = parseSessions(response.optJSONArray("active"))
    val recentActivity = parseSessions(response.optJSONArray("recentActivity"))
    val unread8h = parseSessions(response.optJSONArray("unread8h"))
    val unread24h = parseSessions(response.optJSONArray("unread24h"))
    val allInboxSessions = needsAttention + active + recentActivity + unread8h + unread24h
    val unreadSessions = allInboxSessions
      .filter { it.hasUnread }
      .distinctBy { it.sessionId }
    val unreadIds = unreadSessions.mapTo(mutableSetOf()) { it.sessionId }
    val needsAttentionIds = needsAttention.mapTo(mutableSetOf()) { it.sessionId }
    val badgeCount = if (response.has("badgeCount")) {
      response.optInt("badgeCount", needsAttentionIds.size)
    } else {
      needsAttentionIds.size
    }
    YepNativeNotifier.syncBadge(appContext, badgeCount)

    val visibleNeedsAttention = needsAttention.take(MAX_NOTIFICATIONS_PER_TIER)
    val visibleNeedsAttentionIds =
      visibleNeedsAttention.mapTo(mutableSetOf()) { it.sessionId }
    val visibleActive = active
      .asSequence()
      .filter { !visibleNeedsAttentionIds.contains(it.sessionId) }
      .take(MAX_NOTIFICATIONS_PER_TIER)
      .toList()
    val visibleActiveIds = visibleActive.mapTo(mutableSetOf()) { it.sessionId }

    Log.i(
      TAG,
      "poll: origin=$serverOrigin needsAttention=${needsAttention.size} active=${active.size} unread=${unreadIds.size} badge=$badgeCount visibleNeedsAttention=${visibleNeedsAttentionIds.size} visibleActive=${visibleActiveIds.size}"
    )
    // Ring-buffer only on transitions to keep uploads readable.
    if (visibleNeedsAttentionIds != notifiedNeedsAttention ||
      visibleActiveIds != notifiedRunning
    ) {
      YepLog.i(
        "watcher.poll",
        "needsAttention=${visibleNeedsAttentionIds.size} active=${visibleActiveIds.size} badge=$badgeCount",
      )
    }

    for (session in visibleNeedsAttention) {
      YepNativeNotifier.cancelRunning(appContext, session.sessionId)
      YepNativeNotifier.showPendingInput(
        context = appContext,
        session = session,
        badgeCount = badgeCount,
      )
    }

    for (session in visibleActive) {
      if (notifiedRunning.contains(session.sessionId)) continue
      YepNativeNotifier.showRunning(appContext, session)
    }

    YepNativeNotifier.cancelStaleRunning(appContext, visibleActiveIds)

    cancelMissing(notifiedNeedsAttention, visibleNeedsAttentionIds) { sessionId ->
      YepNativeNotifier.cancelSession(appContext, sessionId)
    }
    cancelMissing(notifiedRunning, visibleActiveIds) { sessionId ->
      YepNativeNotifier.cancelRunning(appContext, sessionId)
    }
    cancelMissing(notifiedUnread, unreadIds + needsAttentionIds) { sessionId ->
      YepNativeNotifier.cancelSession(appContext, sessionId)
    }

    val activeIds = active.mapTo(mutableSetOf()) { it.sessionId }
    val currentBusyIds = activeIds + needsAttentionIds
    val completedUnreadSessions = unreadSessions
      .asSequence()
      .filter { previouslyActive.contains(it.sessionId) }
      .filter { !currentBusyIds.contains(it.sessionId) }
      .take(MAX_NOTIFICATIONS_PER_TIER)
      .toList()
    for (session in completedUnreadSessions) {
      YepNativeNotifier.showSessionHalted(
        context = appContext,
        sessionId = session.sessionId,
        projectId = session.projectId,
        projectName = session.projectName,
        sessionTitle = session.sessionTitle,
        reason = "completed",
        badgeCount = badgeCount,
      )
    }

    notifiedNeedsAttention.clear()
    notifiedNeedsAttention.addAll(visibleNeedsAttentionIds)
    notifiedRunning.clear()
    notifiedRunning.addAll(visibleActiveIds)
    notifiedUnread.clear()
    notifiedUnread.addAll(unreadIds)
    previouslyActive.clear()
    previouslyActive.addAll(activeIds + needsAttentionIds)
  }

  private fun cancelMissing(
    previouslyNotified: Set<String>,
    currentlyVisible: Set<String>,
    cancel: (String) -> Unit,
  ) {
    for (sessionId in previouslyNotified) {
      if (!currentlyVisible.contains(sessionId)) {
        cancel(sessionId)
      }
    }
  }

  private fun getJson(url: String): JSONObject {
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      setRequestProperty("Accept", "application/json")
      CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }
        ?.let { setRequestProperty("Cookie", it) }
    }

    try {
      val status = connection.responseCode
      val stream =
        if (status in 200..299) connection.inputStream else connection.errorStream
      val body = stream?.use { input ->
        BufferedReader(InputStreamReader(input)).use { reader ->
          reader.readText()
        }
      }.orEmpty()

      if (status !in 200..299) {
        throw IllegalStateException("HTTP $status ${body.take(160)}")
      }
      return JSONObject(body)
    } finally {
      connection.disconnect()
    }
  }

  private fun parseSessions(value: JSONArray?): List<YepNativeNotifier.SessionNotification> {
    if (value == null) return emptyList()
    val sessions = mutableListOf<YepNativeNotifier.SessionNotification>()
    for (index in 0 until value.length()) {
      val item = value.optJSONObject(index) ?: continue
      val sessionId = item.optString("sessionId")
      val projectId = item.optString("projectId")
      if (sessionId.isBlank() || projectId.isBlank()) continue

      sessions.add(
        YepNativeNotifier.SessionNotification(
          sessionId = sessionId,
          projectId = projectId,
          projectName = item.optString("projectName", "Yep Anywhere"),
          sessionTitle = item.optString("sessionTitle", "Session"),
          updatedAt = item.optString("updatedAt").takeIf { it.isNotBlank() },
          pendingInputType =
            item.optString("pendingInputType").takeIf { it.isNotBlank() },
          hasUnread = item.optBoolean("hasUnread", false),
          pendingRequestId =
            item.optString("pendingRequestId").takeIf { it.isNotBlank() },
        ),
      )
    }
    return sessions
  }

  private fun normalizeOrigin(value: String): String? {
    return try {
      val url = URL(value)
      if (url.protocol != "http" && url.protocol != "https") return null
      "${url.protocol}://${url.host}${if (url.port >= 0) ":${url.port}" else ""}"
    } catch (_: Throwable) {
      null
    }
  }

  companion object {
    private const val TAG = "YepNativePush"
    private const val POLL_INTERVAL_MS = 15_000L
    private const val CONNECT_TIMEOUT_MS = 5_000
    private const val READ_TIMEOUT_MS = 8_000
    private const val MAX_NOTIFICATIONS_PER_TIER = 3
  }
}
