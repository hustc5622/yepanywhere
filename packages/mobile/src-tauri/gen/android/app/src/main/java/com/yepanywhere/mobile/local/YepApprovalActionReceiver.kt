package com.yepanywhere.mobile.local

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.webkit.CookieManager
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Handles Approve/Deny action buttons on pending-input notifications.
 *
 * The receiver re-reads the session's current pending input before replying:
 * approvals must only be applied when the request the user saw is still the
 * request the agent is waiting on. If the request changed or the reply fails,
 * a fallback notification routes the user into the app instead.
 */
class YepApprovalActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.getStringExtra(EXTRA_ACTION) ?: return
    val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return
    val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
    val projectId = intent.getStringExtra(EXTRA_PROJECT_ID)
    val origin = serverOrigin(context)
    if (origin == null) {
      YepLog.w("onReceive", "no stored server origin; opening app instead")
      YepNativeNotifier.showApprovalFallback(
        context, sessionId, projectId, "Couldn't reach server — open to respond",
      )
      return
    }

    YepLog.i("onReceive", "action=$action sessionId=$sessionId requestId=$requestId")
    // goAsync only buys ~10s of broadcast budget, but external OpenCode
    // approvals can legitimately take up to ~45s to confirm. Release the
    // broadcast on a watchdog and let the worker thread run to completion in
    // the app process (kept alive by the activity / ongoing notifications).
    val pending = goAsync()
    val finished = AtomicBoolean(false)
    val finishBroadcast = {
      if (finished.compareAndSet(false, true)) pending.finish()
    }
    val watchdog = Timer("YepApprovalFinish", true)
    watchdog.schedule(
      object : TimerTask() {
        override fun run() = finishBroadcast()
      },
      BROADCAST_FINISH_MS,
    )
    Thread {
      try {
        applyDecision(context, origin, sessionId, requestId, projectId, action)
      } finally {
        watchdog.cancel()
        finishBroadcast()
      }
    }.apply { isDaemon = true }.start()
  }

  private fun applyDecision(
    context: Context,
    origin: String,
    sessionId: String,
    requestId: String,
    projectId: String?,
    action: String,
  ) {
    try {
      // The pending request may have been answered elsewhere or replaced by a
      // different (possibly more dangerous) one since the notification was
      // posted. Never blind-fire an approval at a stale id.
      val current = currentPendingRequestId(origin, sessionId)
      if (current == null) {
        YepLog.i("applyDecision", "no pending input anymore; dismissing notification")
        YepNativeNotifier.cancelSession(context, sessionId)
        return
      }
      if (current != requestId) {
        YepLog.w("applyDecision", "pending request changed ($requestId -> $current)")
        YepNativeNotifier.showApprovalFallback(
          context, sessionId, projectId, "Request changed — open to review",
        )
        return
      }

      val response = if (action == ACTION_APPROVE) "approve" else "deny"
      val url = "$origin/yep/api/sessions/${android.net.Uri.encode(sessionId)}/input"
      val body = JSONObject()
        .put("requestId", requestId)
        .put("response", response)
        .toString()
      postJson(url, body)
      YepLog.i("applyDecision", "delivered $response for $sessionId")
      YepNativeNotifier.cancelSession(context, sessionId)
    } catch (error: Throwable) {
      YepLog.e("applyDecision", "failed", error)
      // A failed POST does not mean the approval is still pending: races with
      // the web UI / TUI, or an approval that was applied but whose confirming
      // event timed out server-side, both surface here as errors. Re-check the
      // live pending state before alarming the user.
      val still = runCatching { currentPendingRequestId(origin, sessionId) }
      if (still.isSuccess && still.getOrNull() != requestId) {
        YepLog.i("applyDecision", "request no longer pending after failure; treating as resolved")
        YepNativeNotifier.cancelSession(context, sessionId)
        return
      }
      YepNativeNotifier.showApprovalFallback(
        context, sessionId, projectId, "Approval failed — open to respond",
      )
    }
  }

  private fun currentPendingRequestId(origin: String, sessionId: String): String? {
    val url =
      "$origin/yep/api/sessions/${android.net.Uri.encode(sessionId)}/pending-input"
    val response = request(url, "GET", null, READ_TIMEOUT_MS)
    val request = response.optJSONObject("request") ?: return null
    return request.optString("id").takeIf { it.isNotBlank() }
  }

  private fun postJson(url: String, body: String) {
    // Bridge approvals for external OpenCode TUIs are applied asynchronously:
    // the sidecar queues the decision for the forwarder plugin's long-poll
    // (up to 25s) and waits up to 30s for the confirming event. A short read
    // timeout here reported "failed" while the decision was still being
    // (successfully) delivered.
    request(url, "POST", body, DECISION_READ_TIMEOUT_MS)
  }

  private fun request(
    url: String,
    method: String,
    body: String?,
    readTimeoutMs: Int,
  ): JSONObject {
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = readTimeoutMs
    }
    configureApiRequest(
      connection,
      hasBody = body != null,
      cookie = CookieManager.getInstance().getCookie(url),
    )

    try {
      if (body != null) {
        connection.outputStream.use { it.write(body.toByteArray()) }
      }
      val status = connection.responseCode
      val stream =
        if (status in 200..299) connection.inputStream else connection.errorStream
      val text = stream?.use { input ->
        BufferedReader(InputStreamReader(input)).use { it.readText() }
      }.orEmpty()
      if (status !in 200..299) {
        throw IllegalStateException("HTTP $status ${text.take(160)}")
      }
      return if (text.isBlank()) JSONObject() else JSONObject(text)
    } finally {
      connection.disconnect()
    }
  }

  companion object {
    const val EXTRA_ACTION = "yep_approval_action"
    const val EXTRA_SESSION_ID = "yep_approval_session_id"
    const val EXTRA_REQUEST_ID = "yep_approval_request_id"
    const val EXTRA_PROJECT_ID = "yep_approval_project_id"
    const val ACTION_APPROVE = "approve"
    const val ACTION_DENY = "deny"
    private const val PREFS_NAME = "yep_native_push"
    private const val PREF_SERVER_ORIGIN = "server_origin"
    private const val CONNECT_TIMEOUT_MS = 5_000
    private const val READ_TIMEOUT_MS = 8_000

    /**
     * External-instance OpenCode approvals resolve only after the forwarder
     * plugin picks the decision up from a long-poll (<=25s) and OpenCode
     * echoes the terminal event (bridge waits <=30s). Budget past both.
     */
    private const val DECISION_READ_TIMEOUT_MS = 45_000

    /** Broadcast budget: finish() before the ~10s system ANR limit. */
    private const val BROADCAST_FINISH_MS = 8_000L

    internal fun configureApiRequest(
      connection: HttpURLConnection,
      hasBody: Boolean,
      cookie: String?,
    ) {
      connection.setRequestProperty("Accept", "application/json")
      cookie?.takeIf { it.isNotBlank() }
        ?.let { connection.setRequestProperty("Cookie", it) }
      if (hasBody) {
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("X-Yep-Anywhere", "true")
      }
    }

    fun rememberServerOrigin(context: Context, origin: String) {
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(PREF_SERVER_ORIGIN, origin)
        .apply()
    }

    fun serverOrigin(context: Context): String? {
      return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .getString(PREF_SERVER_ORIGIN, null)
        ?.takeIf { it.isNotBlank() }
    }
  }
}
