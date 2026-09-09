package com.yepanywhere.mobile.local

import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Read-only badges for the two sidebar shortcuts, independent of the active page. */
class YepNodeNotifications {
  private val executor = Executors.newFixedThreadPool(2)
  private var closed = false
  private var pending: MutableList<(JSONObject) -> Unit>? = null

  @Synchronized
  fun read(callback: (JSONObject) -> Unit) {
    if (closed) return
    pending?.let {
      it.add(callback)
      return
    }
    pending = mutableListOf(callback)
    val results = mutableMapOf<String, JSONObject>()
    for ((alias, origin) in NODES) {
      executor.execute {
        val result = readNode(alias, origin)
        synchronized(this) {
          if (!closed) {
            results[alias] = result
            if (results.size == NODES.size) {
              val response = JSONObject().put(
                "nodes", JSONArray(NODES.keys.map { results.getValue(it) }),
              )
              val callbacks = pending.orEmpty().toList()
              pending = null
              callbacks.forEach { it(response) }
            }
          }
        }
      }
    }
  }

  @Synchronized
  fun close() {
    closed = true
    pending = null
    executor.shutdownNow()
  }

  private fun readNode(alias: String, origin: String): JSONObject {
    val result = JSONObject().put("alias", alias)
    return try {
      val url = "$origin/yep/api/inbox"
      val connection = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = 5_000
        readTimeout = 8_000
        // Never forward this server's cookies through a redirect.
        instanceFollowRedirects = false
        setRequestProperty("Accept", "application/json")
        CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }
          ?.let { setRequestProperty("Cookie", it) }
      }
      try {
        val status = connection.responseCode
        when {
          status == 401 || status == 403 -> result.put("status", "login-required")
          status !in 200..299 -> result.put("status", "offline")
          else -> {
            val inbox = connection.inputStream.bufferedReader().use {
              JSONObject(it.readText())
            }
            val exactCount = inbox.optInt("finishedUnreadCount", -1)
            if (exactCount >= 0) {
              result.put("finishedUnreadCount", exactCount).put("limited", false)
            } else {
              // Compatibility with servers deployed before the count field.
              // Their inbox tiers already exclude running/approval sessions.
              val unreadIds = mutableSetOf<String>()
              var limited = false
              for (tier in listOf("recentActivity", "unread8h", "unread24h")) {
                val items = inbox.getJSONArray(tier)
                if (items.length() >= 20) limited = true
                for (index in 0 until items.length()) {
                  val item = items.getJSONObject(index)
                  if (item.optBoolean("hasUnread") &&
                    item.optString("activity") != "in-turn" &&
                    item.optString("pendingInputType").isBlank()
                  ) {
                    item.optString("sessionId").takeIf { it.isNotBlank() }
                      ?.let { unreadIds.add(it) }
                  }
                }
              }
              result.put("finishedUnreadCount", unreadIds.size).put("limited", limited)
            }
            result.put("status", "online")
          }
        }
      } finally {
        connection.disconnect()
      }
    } catch (_: Exception) {
      result.put("status", "offline")
    }
  }

  companion object {
    // Fixed allowlist; iframe messages cannot choose arbitrary network targets.
    private val NODES = linkedMapOf(
      "home" to "http://47.95.254.240:5750",
      "mini" to "http://39.106.189.88:18022",
    )
  }
}
