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
import java.util.ArrayDeque
import java.util.UUID

/**
 * Native-side diagnostic log buffer, the Android counterpart of the web
 * client's ClientLogCollector. Call sites log through [i]/[w]/[e], which tee
 * to logcat AND an in-memory ring buffer. [upload] posts the buffer to the
 * server's /api/client-logs collector so native push/approval behavior can be
 * diagnosed without a connected adb device.
 */
object YepLog {
  private const val TAG = "YepNativePush"
  private const val MAX_ENTRIES = 1000
  private const val MAX_UPLOAD_BATCH = 500
  private const val CONNECT_TIMEOUT_MS = 5_000
  private const val READ_TIMEOUT_MS = 15_000
  private const val PREFS_NAME = "yep_native_push"
  private const val PREF_DEVICE_ID = "native_log_device_id"

  private data class Entry(
    val timestamp: Long,
    val level: String,
    val message: String,
  )

  private val buffer = ArrayDeque<Entry>()
  private val lock = Any()

  fun i(scope: String, message: String) {
    Log.i(TAG, "$scope: $message")
    append("info", "$scope: $message")
  }

  fun w(scope: String, message: String) {
    Log.w(TAG, "$scope: $message")
    append("warn", "$scope: $message")
  }

  fun e(scope: String, message: String, error: Throwable? = null) {
    Log.e(TAG, "$scope: $message", error)
    val detail = error?.let { " ${it.javaClass.simpleName}: ${it.message}" } ?: ""
    append("error", "$scope: $message$detail")
  }

  private fun append(level: String, message: String) {
    synchronized(lock) {
      buffer.addLast(Entry(System.currentTimeMillis(), level, message))
      while (buffer.size > MAX_ENTRIES) buffer.removeFirst()
    }
  }

  fun entryCount(): Int = synchronized(lock) { buffer.size }

  /**
   * Upload buffered entries to `$origin/yep/api/client-logs`. Entries are
   * only removed from the buffer after the server acknowledges them, so a
   * failed upload can simply be retried. Returns the number uploaded.
   */
  fun upload(context: Context, origin: String): Int {
    val snapshot: List<Entry> = synchronized(lock) { buffer.toList() }
    if (snapshot.isEmpty()) return 0

    var uploaded = 0
    var index = 0
    while (index < snapshot.size) {
      val batch = snapshot.subList(
        index,
        minOf(index + MAX_UPLOAD_BATCH, snapshot.size),
      )
      postBatch(origin, deviceId(context), batch)
      uploaded += batch.size
      index += batch.size
    }

    // Only drop what we captured; entries appended during the upload stay.
    synchronized(lock) {
      var remaining = uploaded
      while (remaining > 0 && buffer.isNotEmpty()) {
        buffer.removeFirst()
        remaining -= 1
      }
    }
    return uploaded
  }

  private fun postBatch(origin: String, deviceId: String, batch: List<Entry>) {
    val entries = JSONArray()
    for (entry in batch) {
      entries.put(
        JSONObject()
          .put("timestamp", entry.timestamp)
          .put("level", entry.level)
          .put("prefix", "[AndroidNative]")
          .put("message", "[AndroidNative] ${entry.message}"),
      )
    }
    val body = JSONObject()
      .put("entries", entries)
      .put("deviceId", deviceId)
      .toString()

    val url = "$origin/yep/api/client-logs"
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      doOutput = true
      setRequestProperty("Content-Type", "application/json")
      setRequestProperty("Accept", "application/json")
      setRequestProperty("X-Yep-Anywhere", "true")
      CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }
        ?.let { setRequestProperty("Cookie", it) }
    }

    try {
      connection.outputStream.use { it.write(body.toByteArray()) }
      val status = connection.responseCode
      if (status !in 200..299) {
        val text = connection.errorStream?.use { input ->
          BufferedReader(InputStreamReader(input)).use { it.readText() }
        }.orEmpty()
        throw IllegalStateException("HTTP $status ${text.take(160)}")
      }
      // Drain the success body so the connection can be reused.
      connection.inputStream.use { input ->
        BufferedReader(InputStreamReader(input)).use { it.readText() }
      }
    } finally {
      connection.disconnect()
    }
  }

  /** Stable per-install id; the server files logs under it (UUID format). */
  private fun deviceId(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    prefs.getString(PREF_DEVICE_ID, null)?.takeIf { it.isNotBlank() }?.let {
      return it
    }
    val id = UUID.randomUUID().toString()
    prefs.edit().putString(PREF_DEVICE_ID, id).apply()
    return id
  }
}
