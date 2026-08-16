package com.yepanywhere.mobile.local

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var mainWebView: WebView? = null
  private var nativePushBridge: NativePushBridge? = null
  private var sessionWatcher: YepSessionWatcher? = null
  private var pendingNotificationPath: String? = null
  private val pendingPermissionCallbackIds = mutableListOf<String>()

  private val notificationPermissionLauncher =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      markNotificationPermissionRequested()
      resolvePermissionCallbacks(if (granted) "granted" else "denied")
    }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    Log.i(
      TAG,
      "onWebViewCreate: installing JS bridge firebaseApps=${firebaseAppCount()} permission=${notificationPermissionState()}"
    )
    mainWebView = webView
    val bridge = NativePushBridge(this, webView)
    nativePushBridge = bridge
    webView.addJavascriptInterface(bridge, "YepNativePush")
    webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
    pendingNotificationPath?.let { injectNotificationPath(it) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    Log.i(
      TAG,
      "onCreate: sdk=${Build.VERSION.SDK_INT} firebaseApps=${firebaseAppCount()} permission=${notificationPermissionState()}"
    )
    YepNativeNotifier.ensureNotificationChannel(this)

    // With enableEdgeToEdge() the system bars + IME no longer auto-resize
    // the activity, even with android:windowSoftInputMode="adjustResize"
    // declared in the manifest. Without explicit insets handling, opening
    // the soft keyboard pans the whole window upward — which on edge-to-
    // edge looks like the page slides under the status bar.
    //
    // Apply ONLY the keyboard (IME) inset as bottom padding on the root.
    // Status-bar and gesture-nav insets are already handled in CSS via
    // env(safe-area-inset-top / -bottom); doubling that up here would
    // leave a visible gap.
    val rootView = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      // IME inset already includes the system bar height at the bottom
      // when keyboard is up — subtract it so we don't double-pad against
      // CSS's env(safe-area-inset-bottom).
      val keyboardOnlyBottom = (ime.bottom - systemBars.bottom).coerceAtLeast(0)
      view.setPadding(0, 0, 0, keyboardOnlyBottom)
      insets
    }

    handleNotificationIntent(intent)
  }

  private fun setSystemBarTheme(resolvedTheme: String) {
    if (resolvedTheme != "light" && resolvedTheme != "dark") {
      Log.w(TAG, "setSystemBarTheme: ignored invalid theme=$resolvedTheme")
      return
    }

    val useDarkIcons = resolvedTheme == "light"
    runOnUiThread {
      WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = useDarkIcons
        isAppearanceLightNavigationBars = useDarkIcons
      }
      Log.d(
        TAG,
        "setSystemBarTheme: theme=$resolvedTheme darkIcons=$useDarkIcons"
      )
    }
  }

  override fun onDestroy() {
    sessionWatcher?.stop()
    sessionWatcher = null
    // Break the JavaScript-interface reference chain explicitly. WebView owns
    // the bridge, while the bridge owns both this Activity and the WebView.
    // Tauri/Wry still owns final WebView destruction in super.onDestroy().
    mainWebView?.removeJavascriptInterface("YepNativePush")
    nativePushBridge = null
    mainWebView = null
    pendingPermissionCallbackIds.clear()
    pendingNotificationPath = null
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleNotificationIntent(intent)
  }

  private fun handleNotificationIntent(intent: Intent?) {
    val path =
      intent?.getStringExtra(EXTRA_NOTIFICATION_PATH)
        ?: notificationPathFromFcmExtras(intent)
        ?: return
    Log.i(TAG, "handleNotificationIntent: path=$path")
    pendingNotificationPath = path
    injectNotificationPath(path)
  }

  private fun notificationPathFromFcmExtras(intent: Intent?): String? {
    val projectId = intent?.getStringExtra("projectId")
    val sessionId = intent?.getStringExtra("sessionId")
    if (projectId.isNullOrBlank() || sessionId.isNullOrBlank()) return null
    return "/projects/${Uri.encode(projectId)}/sessions/${Uri.encode(sessionId)}"
  }

  private fun injectNotificationPath(path: String) {
    val webView = mainWebView
    if (webView == null) {
      Log.d(TAG, "injectNotificationPath: queued path until WebView is ready")
      return
    }
    val quotedPath = JSONObject.quote(path)
    val script =
      """
        window.__yepPendingNativePushPath = $quotedPath;
        if (window.__yepOpenNativePushPath) {
          window.__yepOpenNativePushPath($quotedPath);
        }
      """.trimIndent()
    webView.post { webView.evaluateJavascript(script, null) }
  }

  private fun isFirebaseAvailable(): Boolean {
    return try {
      FirebaseApp.getApps(this).isNotEmpty()
    } catch (_: Throwable) {
      false
    }
  }

  private fun firebaseAppCount(): Int {
    return try {
      FirebaseApp.getApps(this).size
    } catch (_: Throwable) {
      0
    }
  }

  private fun notificationPermissionState(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return if (NotificationManagerCompat.from(this).areNotificationsEnabled()) {
        "granted"
      } else {
        "denied"
      }
    }

    val permissionGranted =
      ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.POST_NOTIFICATIONS
      ) == PackageManager.PERMISSION_GRANTED

    if (permissionGranted && NotificationManagerCompat.from(this).areNotificationsEnabled()) {
      return "granted"
    }

    return if (hasRequestedNotificationPermission()) "denied" else "default"
  }

  private fun nativePushStatusJson(): JSONObject {
    return JSONObject()
      .put("supported", isFirebaseAvailable())
      .put("permission", notificationPermissionState())
  }

  private fun requestNotificationPermission(callbackId: String) {
    val currentState = notificationPermissionState()
    Log.i(
      TAG,
      "requestPermission: callbackId=$callbackId sdk=${Build.VERSION.SDK_INT} current=$currentState pending=${pendingPermissionCallbackIds.size}"
    )

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      nativePushBridge?.respond(callbackId, true, nativePushStatusJson(), null)
      return
    }

    if (currentState == "granted") {
      nativePushBridge?.respond(callbackId, true, nativePushStatusJson(), null)
      return
    }

    if (currentState == "denied") {
      nativePushBridge?.respond(callbackId, true, nativePushStatusJson(), null)
      return
    }

    pendingPermissionCallbackIds.add(callbackId)
    Log.i(TAG, "requestPermission: launching POST_NOTIFICATIONS system prompt")
    notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
  }

  private fun resolvePermissionCallbacks(permission: String? = null) {
    val callbacks = pendingPermissionCallbackIds.toList()
    pendingPermissionCallbackIds.clear()
    val result =
      permission?.let {
        JSONObject()
          .put("supported", isFirebaseAvailable())
          .put("permission", it)
      } ?: nativePushStatusJson()
    Log.i(
      TAG,
      "resolvePermissionCallbacks: count=${callbacks.size} permission=${result.optString("permission")}"
    )
    for (callbackId in callbacks) {
      nativePushBridge?.respond(callbackId, true, result, null)
    }
  }

  private fun hasRequestedNotificationPermission(): Boolean {
    return getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
      .getBoolean(PREF_NOTIFICATION_PERMISSION_REQUESTED, false)
  }

  private fun markNotificationPermissionRequested() {
    getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
      .edit()
      .putBoolean(PREF_NOTIFICATION_PERMISSION_REQUESTED, true)
      .apply()
  }

  private fun getFcmToken(callbackId: String) {
    Log.i(
      TAG,
      "getToken: callbackId=$callbackId firebaseApps=${firebaseAppCount()} permission=${notificationPermissionState()}"
    )

    if (!isFirebaseAvailable()) {
      Log.w(TAG, "getToken: Firebase is not configured")
      nativePushBridge?.respond(
        callbackId,
        false,
        null,
        "Firebase is not configured for this APK build"
      )
      return
    }

    FirebaseMessaging.getInstance().token
      .addOnSuccessListener { token ->
        Log.i(TAG, "getToken: success callbackId=$callbackId tokenLength=${token.length}")
        nativePushBridge?.respond(
          callbackId,
          true,
          JSONObject().put("token", token),
          null
        )
      }
      .addOnFailureListener { error ->
        Log.e(
          TAG,
          "getToken: failed callbackId=$callbackId ${error.javaClass.simpleName}: ${error.message}",
          error
        )
        nativePushBridge?.respond(
          callbackId,
          false,
          null,
          error.message ?: "Failed to get FCM token"
        )
      }
  }

  private fun configureSessionWatcher(origin: String) {
    // Persist for YepApprovalActionReceiver: notification Approve/Deny must
    // reach the server even when the app process was since killed.
    YepApprovalActionReceiver.rememberServerOrigin(applicationContext, origin)
    runOnUiThread {
      val watcher = sessionWatcher ?: YepSessionWatcher(applicationContext).also {
        sessionWatcher = it
      }
      watcher.start(origin)
    }
  }

  private fun uploadNativeLogs(callbackId: String) {
    val origin = YepApprovalActionReceiver.serverOrigin(applicationContext)
    if (origin == null) {
      YepLog.w("uploadLogs", "no stored server origin")
      nativePushBridge?.respond(
        callbackId,
        false,
        null,
        "Server origin unknown; open a server first",
      )
      return
    }

    Thread {
      try {
        val count = YepLog.upload(applicationContext, origin)
        YepLog.i("uploadLogs", "uploaded=$count origin=$origin")
        nativePushBridge?.respond(
          callbackId,
          true,
          JSONObject().put("uploaded", count),
          null,
        )
      } catch (error: Throwable) {
        YepLog.e("uploadLogs", "failed", error)
        nativePushBridge?.respond(
          callbackId,
          false,
          null,
          error.message ?: "Log upload failed",
        )
      }
    }.apply { isDaemon = true }.start()
  }

  class NativePushBridge(
    private val activity: MainActivity,
    private val webView: WebView
  ) {
    @JavascriptInterface
    fun getShellDiagnostics(): String {
      val webViewPackage =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          WebView.getCurrentWebViewPackage()
        } else {
          null
        }
      return JSONObject()
        .put("appVersion", BuildConfig.VERSION_NAME)
        .put("versionCode", BuildConfig.VERSION_CODE)
        .put("androidSdk", Build.VERSION.SDK_INT)
        .put("device", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
        .put("webViewPackage", webViewPackage?.packageName ?: JSONObject.NULL)
        .put("webViewVersion", webViewPackage?.versionName ?: JSONObject.NULL)
        .put("nativeLogEntries", YepLog.entryCount())
        .toString()
    }

    @JavascriptInterface
    fun getStatus(callbackId: String) {
      val status = activity.nativePushStatusJson()
      Log.i(
        TAG,
        "bridge.getStatus: callbackId=$callbackId supported=${status.optBoolean("supported")} permission=${status.optString("permission")}"
      )
      respond(callbackId, true, status, null)
    }

    @JavascriptInterface
    fun requestPermission(callbackId: String) {
      Log.i(TAG, "bridge.requestPermission: callbackId=$callbackId")
      activity.requestNotificationPermission(callbackId)
    }

    @JavascriptInterface
    fun getToken(callbackId: String) {
      Log.i(TAG, "bridge.getToken: callbackId=$callbackId")
      activity.getFcmToken(callbackId)
    }

    @JavascriptInterface
    fun configureSessionWatcher(origin: String) {
      Log.i(TAG, "bridge.configureSessionWatcher: origin=$origin")
      activity.configureSessionWatcher(origin)
    }

    @JavascriptInterface
    fun setSystemBarTheme(resolvedTheme: String) {
      activity.setSystemBarTheme(resolvedTheme)
    }

    @JavascriptInterface
    fun uploadLogs(callbackId: String) {
      Log.i(TAG, "bridge.uploadLogs: callbackId=$callbackId")
      activity.uploadNativeLogs(callbackId)
    }

    @JavascriptInterface
    fun log(message: String) {
      Log.d(TAG, "js: $message")
    }

    fun resolvePermissionCallbacks() {
      activity.resolvePermissionCallbacks()
    }

    fun respond(
      callbackId: String,
      ok: Boolean,
      result: JSONObject?,
      error: String?
    ) {
      val response = JSONObject()
        .put("ok", ok)
        .put("result", result ?: JSONObject.NULL)
        .put("error", error ?: JSONObject.NULL)
      val script =
        "window.__yepNativePushResolve(${JSONObject.quote(callbackId)}, ${
          JSONObject.quote(response.toString())
        })"
      Log.i(
        TAG,
        "bridge.respond: callbackId=$callbackId ok=$ok error=${error ?: "null"} resultKeys=${result?.keys()?.asSequence()?.joinToString(",") ?: "none"}"
      )
      webView.post {
        webView.evaluateJavascript(script) { value ->
          Log.d(TAG, "bridge.respond evaluated: callbackId=$callbackId value=$value")
        }
      }
    }
  }

  companion object {
    const val EXTRA_NOTIFICATION_PATH = "yep_notification_path"
    private const val TAG = "YepNativePush"
    private const val PREFS_NAME = "yep_native_push"
    private const val PREF_NOTIFICATION_PERMISSION_REQUESTED =
      "notification_permission_requested"
  }
}
