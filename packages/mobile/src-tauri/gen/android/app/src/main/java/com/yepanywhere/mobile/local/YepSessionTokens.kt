package com.yepanywhere.mobile.local

import android.content.Context
import android.webkit.CookieManager
import java.net.HttpURLConnection
import java.net.URL

/**
 * Session tokens handed over by the framed web app.
 *
 * The shell page lives at https://tauri.localhost and frames the Yep server,
 * usually over plain HTTP. That iframe is cross-site, so the server's
 * SameSite=Lax session cookie never reaches CookieManager (and SameSite=None
 * would need Secure, impossible over HTTP). The web app therefore holds a
 * bearer token and forwards it through the shell; native callers that used to
 * replay the WebView cookie (session watcher, notification approvals, node
 * badges, downloads) present that token as well.
 */
object YepSessionTokens {
  private const val PREFS_NAME = "yep_session_tokens"
  private const val MAX_TOKEN_LENGTH = 512
  private val SAFE_TOKEN = Regex("^[A-Za-z0-9._-]+$")

  @Volatile
  private var appContext: Context? = null

  fun init(context: Context) {
    appContext = context.applicationContext
  }

  /** `scheme://host[:port]` for http(s) URLs, otherwise null. */
  fun originOf(value: String): String? {
    return try {
      val url = URL(value)
      val scheme = url.protocol?.lowercase() ?: return null
      if (scheme != "http" && scheme != "https") return null
      val host = url.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
      "$scheme://$host${if (url.port >= 0) ":${url.port}" else ""}"
    } catch (_: Throwable) {
      null
    }
  }

  /** Store (or clear, when [token] is blank) the token for [origin]. */
  fun store(origin: String, token: String?) {
    val context = appContext ?: return
    val key = originOf(origin) ?: return
    val value = token?.trim().orEmpty()
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
    if (value.isEmpty() || value.length > MAX_TOKEN_LENGTH || !isTokenSafe(value)) {
      prefs.remove(key)
      YepLog.i("sessionToken", "cleared origin=$key")
    } else {
      prefs.putString(key, value)
      YepLog.i("sessionToken", "stored origin=$key")
    }
    prefs.apply()
  }

  fun tokenFor(url: String): String? {
    val context = appContext ?: return null
    val key = originOf(url) ?: return null
    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getString(key, null)
      ?.takeIf { it.isNotBlank() }
  }

  /** Value for the `Authorization` header, or null without a token. */
  fun authorizationHeader(token: String?): String? {
    return token?.trim()?.takeIf { it.isNotEmpty() }?.let { "Bearer $it" }
  }

  /** Attach the WebView cookie (browser-style logins) and the bearer token. */
  fun authorize(connection: HttpURLConnection, url: String) {
    CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }
      ?.let { connection.setRequestProperty("Cookie", it) }
    authorizationHeader(tokenFor(url))
      ?.let { connection.setRequestProperty("Authorization", it) }
  }

  /** Tokens are opaque hex today; refuse anything that could break a header. */
  private fun isTokenSafe(value: String): Boolean {
    return SAFE_TOKEN.matches(value)
  }
}
