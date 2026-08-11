(function () {
  var APP_READY_MESSAGE = "yep-anywhere:app-ready";
  var CHANNEL_STATUS_MESSAGE = "yep-anywhere:mobile-shell-channel";
  var GET_CHANNEL_MESSAGE = "yep-anywhere:mobile-shell-get-channel";
  var SET_CHANNEL_MESSAGE = "yep-anywhere:mobile-shell-set-channel";
  var NATIVE_PUSH_REQUEST_MESSAGE = "yep-anywhere:native-push-request";
  var NATIVE_PUSH_RESPONSE_MESSAGE = "yep-anywhere:native-push-response";
  var NATIVE_PUSH_DEBUG_MESSAGE = "yep-anywhere:native-push-debug";
  var CHANNEL_STORAGE_KEY = "yep-anywhere-mobile-channel";
  var ACTIVE_NODE_STORAGE_KEY = "yep-anywhere-mobile-active-node";
  var NODE_HISTORY_STORAGE_KEY = "yep-anywhere-mobile-node-history";
  var DEFAULT_CHANNEL = "tcp";
  var TCP_NODES = [
    {
      alias: "air",
      label: "43.226.60.75:46789",
      origin: "http://43.226.60.75:46789"
    },
    {
      alias: "mini",
      label: "39.106.200.1:18022",
      origin: "http://39.106.200.1:18022"
    },
    {
      alias: "home",
      label: "47.95.254.240:5750",
      origin: "http://47.95.254.240:5750"
    }
  ];
  var DEFAULT_TCP_ORIGIN = TCP_NODES[0].origin;
  var SEEDED_NODE_HISTORY = [
    DEFAULT_TCP_ORIGIN,
    TCP_NODES[1].origin,
    TCP_NODES[2].origin
  ];
  var DEPRECATED_DEFAULT_TCP_ORIGINS = [
    "http://123.56.106.49:37160",
    "http://43.226.60.75:61874"
  ];
  var NODE_HISTORY_LIMIT = 8;
  var APP_READY_TIMEOUT_MS = 12000;
  var SLOW_STATUS_MS = 8000;
  // The longest iframe-side native request timeout is 60 seconds (log upload).
  // Keep a small grace period, then release the source WindowProxy even if the
  // Android callback was lost.
  var NATIVE_PUSH_PENDING_TIMEOUT_MS = 65000;
  var CHANNELS = {
    tcp: {
      label: "TCP",
      status: "Connecting via TCP",
      origin: DEFAULT_TCP_ORIGIN
    },
    http: {
      label: "HTTPS relay",
      status: "Connecting via HTTPS relay",
      origin: "https://air.yueyuan.uk"
    }
  };
  var STRINGS = {
    en: {
      documentTitle: "Yep Anywhere",
      connection: "Connection",
      close: "Close",
      loading: "Loading Yep Anywhere",
      serverNode: "Server node",
      connect: "Connect",
      savedNodes: "Saved nodes",
      httpsRelay: "HTTPS relay",
      retry: "Retry",
      useDefault: "Use default",
      diagnostics: "Diagnostics",
      currentTarget: "Current target",
      defaultTarget: "Default target",
      connectionState: "Connection state",
      network: "Network",
      frameLoad: "Frame load",
      attemptStarted: "Attempt started",
      appVersion: "App version",
      androidWebView: "Android / WebView",
      nativeBridge: "Native bridge",
      copyDiagnostics: "Copy diagnostics",
      copied: "Copied",
      openAnyway: "Open page anyway",
      connectingViaTcp: "Connecting via TCP",
      connectingViaHttps: "Connecting via HTTPS relay",
      connectingTo: "Connecting to {target}",
      waitingForApp: "WebView load event received; waiting for Yep Anywhere",
      stillConnecting: "Still connecting to {target}",
      connectionFailed: "Could not verify Yep Anywhere at {target}",
      connectionFailedHint:
        "The server may be offline or the address may have changed. Update the address or retry.",
      invalidNode: "Enter a server as host:port or http(s)://host:port",
      ready: "Ready",
      connecting: "Connecting",
      failed: "Timed out",
      unverified: "Opened without verification",
      online: "Online",
      offline: "Offline",
      seen: "Seen",
      notSeen: "Not seen",
      available: "Available",
      unavailable: "Unavailable",
      unknown: "Unknown",
      never: "Never"
    },
    "zh-CN": {
      documentTitle: "Yep Anywhere",
      connection: "连接设置",
      close: "关闭",
      loading: "正在加载 Yep Anywhere",
      serverNode: "服务器地址",
      connect: "连接",
      savedNodes: "已保存地址",
      httpsRelay: "HTTPS 中继",
      retry: "重试",
      useDefault: "恢复默认",
      diagnostics: "诊断信息",
      currentTarget: "当前地址",
      defaultTarget: "默认地址",
      connectionState: "连接状态",
      network: "系统网络",
      frameLoad: "网页加载事件",
      attemptStarted: "开始时间",
      appVersion: "App 版本",
      androidWebView: "Android / WebView",
      nativeBridge: "原生桥",
      copyDiagnostics: "复制诊断",
      copied: "已复制",
      openAnyway: "仍然打开网页",
      connectingViaTcp: "正在通过 TCP 连接",
      connectingViaHttps: "正在通过 HTTPS 中继连接",
      connectingTo: "正在连接 {target}",
      waitingForApp: "WebView 已触发加载事件，正在等待 Yep Anywhere 就绪",
      stillConnecting: "仍在连接 {target}",
      connectionFailed: "无法确认 {target} 上的 Yep Anywhere 已就绪",
      connectionFailedHint: "服务器可能已离线或地址已变化，请修改地址或重试。",
      invalidNode: "请输入 host:端口 或 http(s)://host:端口",
      ready: "已连接",
      connecting: "连接中",
      failed: "连接超时",
      unverified: "未验证打开",
      online: "网络在线",
      offline: "网络离线",
      seen: "已触发",
      notSeen: "未触发",
      available: "可用",
      unavailable: "不可用",
      unknown: "未知",
      never: "无"
    }
  };
  var language = /^zh(?:-|$)/i.test(window.navigator.language || "")
    ? "zh-CN"
    : "en";
  var loaded = false;
  var appReadyTimer = null;
  var slowStatusTimer = null;
  var activeChannel = DEFAULT_CHANNEL;
  var activeTarget = null;
  var connectionState = "connecting";
  var attemptStartedAt = null;
  var frameLoadedAt = null;
  var appReadyAt = null;
  var nativeDiagnostics = null;
  var pendingNativePushFrames = {};
  var pendingNativePushTimers = {};

  function t(key, values) {
    var table = STRINGS[language] || STRINGS.en;
    var template = table[key] || STRINGS.en[key] || key;
    if (!values) return template;

    return template.replace(/\{([^}]+)\}/g, function (_match, name) {
      return Object.prototype.hasOwnProperty.call(values, name)
        ? String(values[name])
        : "";
    });
  }

  function applyTranslations() {
    document.documentElement.lang = language;
    document.title = t("documentTitle");

    var textNodes = document.querySelectorAll("[data-i18n]");
    for (var index = 0; index < textNodes.length; index += 1) {
      var key = textNodes[index].getAttribute("data-i18n");
      if (key) textNodes[index].textContent = t(key);
    }

    var labelledNodes = document.querySelectorAll("[data-i18n-label]");
    for (var labelIndex = 0; labelIndex < labelledNodes.length; labelIndex += 1) {
      var labelKey = labelledNodes[labelIndex].getAttribute("data-i18n-label");
      if (!labelKey) continue;
      labelledNodes[labelIndex].setAttribute("aria-label", t(labelKey));
      labelledNodes[labelIndex].setAttribute("title", t(labelKey));
    }
  }

  function logNativePush(message) {
    try {
      if (
        window.YepNativePush &&
        typeof window.YepNativePush.log === "function"
      ) {
        window.YepNativePush.log(message);
        return;
      }
    } catch (_err) {
      // Keep diagnostics best-effort only.
    }

    try {
      if (window.console && typeof window.console.log === "function") {
        window.console.log("[YepNativePush] " + message);
      }
    } catch (_err) {
      // Ignore console failures in restricted WebView modes.
    }
  }

  function isValidChannel(channel) {
    return Object.prototype.hasOwnProperty.call(CHANNELS, channel);
  }

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_err) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_err) {
      // Storage can be unavailable in restricted WebView modes.
    }
  }

  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_err) {
      // Storage can be unavailable in restricted WebView modes.
    }
  }

  function getStoredChannel() {
    var value = readStorage(CHANNEL_STORAGE_KEY);
    return isValidChannel(value) ? value : null;
  }

  function getRequestedTarget() {
    try {
      var params = new URLSearchParams(window.location.search);
      var node = params.get("node") || params.get("server");
      if (node) {
        return targetFromNodeInput(node);
      }

      var value = params.get("channel");
      return isValidChannel(value) ? targetFromChannel(value) : null;
    } catch (_err) {
      return null;
    }
  }

  function storeChannel(channel) {
    writeStorage(CHANNEL_STORAGE_KEY, channel);
  }

  function normalizeNodeInput(value) {
    if (typeof value !== "string") return null;

    var trimmed = value.trim().replace(/\s+/g, "");
    if (!trimmed) return null;

    var candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : "http://" + trimmed;

    try {
      var url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (!url.hostname || !url.port) return null;

      var origin = url.protocol + "//" + url.host;
      return {
        label: origin.replace(/^http:\/\//, ""),
        origin: origin
      };
    } catch (_err) {
      return null;
    }
  }

  function isDeprecatedDefaultNode(origin) {
    for (var index = 0; index < DEPRECATED_DEFAULT_TCP_ORIGINS.length; index += 1) {
      if (DEPRECATED_DEFAULT_TCP_ORIGINS[index] === origin) return true;
    }
    return false;
  }

  function getKnownTcpNode(origin) {
    for (var index = 0; index < TCP_NODES.length; index += 1) {
      if (TCP_NODES[index].origin === origin) return TCP_NODES[index];
    }
    return null;
  }

  function getNodeDisplayLabel(node) {
    var knownNode = getKnownTcpNode(node.origin);
    var label = knownNode ? knownNode.label : node.label;
    return knownNode && knownNode.alias
      ? label + " (" + knownNode.alias + ")"
      : label;
  }

  function targetFromNodeInput(value) {
    var node = normalizeNodeInput(value);
    if (!node) return null;

    var displayLabel = getNodeDisplayLabel(node);
    return {
      channel: "tcp",
      displayLabel: displayLabel,
      label: node.label,
      nodeOrigin: node.origin,
      origin: node.origin,
      status: t("connectingTo", { target: displayLabel })
    };
  }

  function getStoredActiveNode() {
    var value = readStorage(ACTIVE_NODE_STORAGE_KEY);
    var node = value ? normalizeNodeInput(value) : null;
    if (node && isDeprecatedDefaultNode(node.origin)) {
      removeStorage(ACTIVE_NODE_STORAGE_KEY);
      return null;
    }
    return node;
  }

  function storeActiveNode(origin) {
    var node = normalizeNodeInput(origin);
    if (!node) return;
    writeStorage(ACTIVE_NODE_STORAGE_KEY, node.origin);
  }

  function dedupeNodes(nodes) {
    var result = [];
    var seen = {};

    for (var index = 0; index < nodes.length; index += 1) {
      var node = normalizeNodeInput(nodes[index]);
      if (node && isDeprecatedDefaultNode(node.origin)) continue;
      if (!node || seen[node.origin]) continue;
      seen[node.origin] = true;
      result.push(node.origin);
    }

    return result;
  }

  function getStoredNodeHistory() {
    var stored = readStorage(NODE_HISTORY_STORAGE_KEY);
    var parsed = [];

    if (stored) {
      try {
        var value = JSON.parse(stored);
        if (Array.isArray(value)) parsed = value;
      } catch (_err) {
        parsed = [];
      }
    }

    return dedupeNodes(parsed.concat(SEEDED_NODE_HISTORY)).slice(
      0,
      NODE_HISTORY_LIMIT
    );
  }

  function storeNodeHistory(nodes) {
    writeStorage(
      NODE_HISTORY_STORAGE_KEY,
      JSON.stringify(dedupeNodes(nodes).slice(0, NODE_HISTORY_LIMIT))
    );
  }

  function addNodeToHistory(origin) {
    storeNodeHistory([origin].concat(getStoredNodeHistory()));
  }

  function targetFromChannel(channel) {
    if (!isValidChannel(channel)) channel = DEFAULT_CHANNEL;

    if (channel === "tcp") {
      var storedNode = getStoredActiveNode();
      return (
        targetFromNodeInput(storedNode ? storedNode.origin : DEFAULT_TCP_ORIGIN)
      );
    }

    return {
      channel: channel,
      label: CHANNELS[channel].label,
      origin: CHANNELS[channel].origin,
      status: t("connectingViaHttps")
    };
  }

  function getStoredTarget() {
    var storedChannel = getStoredChannel();
    if (storedChannel === "http") return targetFromChannel("http");

    var storedNode = getStoredActiveNode();
    if (storedNode) return targetFromNodeInput(storedNode.origin);
    if (storedChannel === "tcp") return targetFromChannel("tcp");

    return null;
  }

  function normalizeAppPath(path) {
    if (typeof path !== "string" || path.charAt(0) !== "/") {
      return "/yep/";
    }
    return path.indexOf("/yep") === 0 ? path : "/yep" + path;
  }

  function getFrameUrl(target, path) {
    var url = new URL(target.origin + normalizeAppPath(path));
    if (!path && window.location.hash) {
      url.hash = window.location.hash;
    }
    url.searchParams.set("yep-mobile-shell", "1");
    return url.toString();
  }

  function configureNativeSessionWatcher(target) {
    if (!target || !target.origin) return;
    try {
      if (
        window.YepNativePush &&
        typeof window.YepNativePush.configureSessionWatcher === "function"
      ) {
        logNativePush("configure session watcher origin=" + target.origin);
        window.YepNativePush.configureSessionWatcher(target.origin);
      }
    } catch (error) {
      logNativePush(
        "configure session watcher failed: " +
          (error && error.message ? error.message : "unknown")
      );
    }
  }

  function getFramePathFromMessage(data) {
    return data && typeof data.path === "string" ? data.path : null;
  }

  function getPendingNativePushPath() {
    var path =
      typeof window.__yepPendingNativePushPath === "string"
        ? window.__yepPendingNativePushPath
        : null;
    window.__yepPendingNativePushPath = null;
    return path;
  }

  function getNodeFromMessage(data) {
    if (!data) return null;
    if (typeof data.node === "string") return data.node;
    if (typeof data.origin === "string") return data.origin;
    return null;
  }

  function getCurrentFramePath() {
    var frame = document.getElementById("app-frame");
    if (!frame || !frame.src) return null;

    try {
      var url = new URL(frame.src);
      return url.pathname + url.search + url.hash;
    } catch (_err) {
      return null;
    }
  }

  function updateStatus(text) {
    var status = document.querySelector("[data-loader-status]");
    if (status) status.textContent = text;
  }

  function updateNodeError(text) {
    var error = document.querySelector("[data-node-error]");
    if (error) error.textContent = text || "";
  }

  function readNativeDiagnostics() {
    try {
      if (
        window.YepNativePush &&
        typeof window.YepNativePush.getShellDiagnostics === "function"
      ) {
        var value = window.YepNativePush.getShellDiagnostics();
        nativeDiagnostics = typeof value === "string" ? JSON.parse(value) : value;
      }
    } catch (error) {
      nativeDiagnostics = {
        error: error && error.message ? error.message : "native diagnostics failed"
      };
    }
  }

  function formatTimestamp(value) {
    if (!value) return t("never");
    try {
      return new Date(value).toLocaleString(language);
    } catch (_err) {
      return value;
    }
  }

  function getConnectionStateLabel() {
    if (connectionState === "ready") return t("ready");
    if (connectionState === "failed") return t("failed");
    if (connectionState === "unverified") return t("unverified");
    return t("connecting");
  }

  function getDiagnosticSnapshot() {
    return {
      capturedAt: new Date().toISOString(),
      connectionState: connectionState,
      currentTarget: activeTarget ? activeTarget.origin : null,
      defaultTarget: DEFAULT_TCP_ORIGIN,
      storedChannel: readStorage(CHANNEL_STORAGE_KEY),
      storedNode: readStorage(ACTIVE_NODE_STORAGE_KEY),
      attemptStartedAt: attemptStartedAt,
      frameLoadedAt: frameLoadedAt,
      appReadyAt: appReadyAt,
      appReadyTimeoutMs: APP_READY_TIMEOUT_MS,
      navigatorOnline: window.navigator.onLine,
      language: language,
      nativeBridgeAvailable: !!window.YepNativePush,
      native: nativeDiagnostics,
      userAgent: window.navigator.userAgent
    };
  }

  function setDiagnosticText(selector, value) {
    var element = document.querySelector(selector);
    if (element) element.textContent = value;
  }

  function renderDiagnostics() {
    if (!nativeDiagnostics) readNativeDiagnostics();

    setDiagnosticText(
      "[data-diagnostic-target]",
      activeTarget ? activeTarget.origin : t("unknown")
    );
    setDiagnosticText("[data-diagnostic-default]", DEFAULT_TCP_ORIGIN);
    setDiagnosticText("[data-diagnostic-state]", getConnectionStateLabel());
    setDiagnosticText(
      "[data-diagnostic-network]",
      window.navigator.onLine ? t("online") : t("offline")
    );
    setDiagnosticText(
      "[data-diagnostic-frame]",
      frameLoadedAt ? t("seen") + " · " + formatTimestamp(frameLoadedAt) : t("notSeen")
    );
    setDiagnosticText(
      "[data-diagnostic-attempt]",
      formatTimestamp(attemptStartedAt)
    );
    setDiagnosticText(
      "[data-diagnostic-version]",
      nativeDiagnostics && nativeDiagnostics.appVersion
        ? nativeDiagnostics.appVersion +
            (nativeDiagnostics.versionCode
              ? " (" + nativeDiagnostics.versionCode + ")"
              : "")
        : t("unknown")
    );
    setDiagnosticText(
      "[data-diagnostic-webview]",
      nativeDiagnostics
        ? [
            nativeDiagnostics.androidSdk
              ? "SDK " + nativeDiagnostics.androidSdk
              : null,
            nativeDiagnostics.webViewVersion || null
          ]
            .filter(Boolean)
            .join(" · ") || t("unknown")
        : t("unknown")
    );
    setDiagnosticText(
      "[data-diagnostic-bridge]",
      window.YepNativePush ? t("available") : t("unavailable")
    );

    if (document.body) {
      document.body.setAttribute("data-connection-state", connectionState);
    }
  }

  function fallbackCopyText(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    var copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (_err) {
      copied = false;
    }
    textarea.remove();
    return copied;
  }

  function copyDiagnostics(button) {
    var text = JSON.stringify(getDiagnosticSnapshot(), null, 2);
    var copyPromise = null;
    if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
      copyPromise = window.navigator.clipboard.writeText(text);
    } else {
      copyPromise = fallbackCopyText(text)
        ? Promise.resolve()
        : Promise.reject(new Error("clipboard unavailable"));
    }

    copyPromise
      .then(function () {
        if (!button) return;
        button.textContent = t("copied");
        window.setTimeout(function () {
          button.textContent = t("copyDiagnostics");
        }, 1600);
      })
      .catch(function () {
        updateNodeError(text);
      });
  }

  function renderConnectionControls() {
    var input = document.querySelector("[data-node-input]");
    var nodeLabel =
      activeTarget && activeTarget.nodeOrigin ? activeTarget.label : null;

    if (input && document.activeElement !== input) {
      input.value =
        nodeLabel ||
        (getStoredActiveNode() || normalizeNodeInput(DEFAULT_TCP_ORIGIN))
          .label;
    }

    var history = document.querySelector("[data-node-history]");
    if (history) {
      history.textContent = "";

      var nodes = getStoredNodeHistory();
      for (var index = 0; index < nodes.length; index += 1) {
        var node = normalizeNodeInput(nodes[index]);
        if (!node) continue;

        var button = document.createElement("button");
        button.type = "button";
        button.className = "shell-loader__history-button";
        if (activeTarget && activeTarget.nodeOrigin === node.origin) {
          button.className += " is-active";
        }
        button.textContent = getNodeDisplayLabel(node);
        button.setAttribute("data-node-origin", node.origin);
        button.addEventListener("click", function (event) {
          var origin = event.currentTarget.getAttribute("data-node-origin");
          loadNode(origin, { path: getCurrentFramePath() });
        });
        history.appendChild(button);
      }
    }

    var httpButton = document.querySelector("[data-http-channel]");
    if (httpButton) {
      httpButton.className =
        "shell-loader__channel-button" +
        (activeChannel === "http" ? " is-active" : "");
    }

    renderDiagnostics();
  }

  function postChannelStatus() {
    var frame = document.getElementById("app-frame");
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      {
        type: CHANNEL_STATUS_MESSAGE,
        channel: activeChannel,
        node:
          activeTarget && activeTarget.nodeOrigin
            ? activeTarget.displayLabel || activeTarget.label
            : null,
        origin: activeTarget ? activeTarget.origin : null
      },
      "*"
    );
  }

  function clearTimers() {
    if (appReadyTimer !== null) {
      window.clearTimeout(appReadyTimer);
      appReadyTimer = null;
    }
    if (slowStatusTimer !== null) {
      window.clearTimeout(slowStatusTimer);
      slowStatusTimer = null;
    }
  }

  function resetLoading(target) {
    loaded = false;
    connectionState = "connecting";
    attemptStartedAt = new Date().toISOString();
    frameLoadedAt = null;
    appReadyAt = null;
    clearTimers();
    if (document.body) {
      document.body.classList.remove("is-loaded", "has-connection-error");
      document.body.classList.add("is-panel-open");
    }
    updateStatus(target.status);
    updateNodeError("");
    renderConnectionControls();
  }

  function markLoaded() {
    if (!document.body || connectionState === "ready") return;
    loaded = true;
    connectionState = "ready";
    appReadyAt = new Date().toISOString();
    configureNativeSessionWatcher(activeTarget);
    clearTimers();
    document.body.classList.add("is-loaded");
    document.body.classList.remove("is-panel-open", "has-connection-error");
    renderConnectionControls();
  }

  function markConnectionFailed() {
    if (loaded || !document.body) return;
    connectionState = "failed";
    clearTimers();
    document.body.classList.add("has-connection-error", "is-panel-open");
    updateStatus(
      t("connectionFailed", {
        target: activeTarget
          ? activeTarget.displayLabel || activeTarget.label
          : t("unknown")
      })
    );
    updateNodeError(t("connectionFailedHint"));
    renderConnectionControls();
  }

  function openSettings() {
    if (!document.body) return;
    document.body.classList.add("is-panel-open");
    renderConnectionControls();
  }

  function closeSettings() {
    if (!loaded || !document.body) return;
    document.body.classList.remove("is-panel-open");
  }

  function openUnverifiedPage() {
    if (!document.body) return;
    loaded = true;
    connectionState = "unverified";
    clearTimers();
    document.body.classList.add("is-loaded");
    document.body.classList.remove("is-panel-open", "has-connection-error");
    renderConnectionControls();
  }

  function updateSlowStatus() {
    if (slowStatusTimer !== null) window.clearTimeout(slowStatusTimer);
    slowStatusTimer = window.setTimeout(function () {
      if (loaded || !document.body) return;
      updateStatus(
        activeTarget
          ? t("stillConnecting", {
              target: activeTarget.displayLabel || activeTarget.label
            })
          : t("connecting")
      );
    }, SLOW_STATUS_MS);
  }

  function startAppReadyTimeout() {
    if (appReadyTimer !== null) window.clearTimeout(appReadyTimer);
    appReadyTimer = window.setTimeout(markConnectionFailed, APP_READY_TIMEOUT_MS);
  }

  function loadTarget(target, options) {
    if (!target) target = targetFromChannel(DEFAULT_CHANNEL);
    activeTarget = target;
    activeChannel = target.channel;

    if (!options || options.persist !== false) {
      storeChannel(target.channel);
      if (target.nodeOrigin) {
        storeActiveNode(target.nodeOrigin);
        addNodeToHistory(target.nodeOrigin);
      }
    }

    resetLoading(target);

    var frame = document.getElementById("app-frame");
    if (!frame) {
      markConnectionFailed();
      return;
    }

    frame.onload = function () {
      frameLoadedAt = new Date().toISOString();
      if (!loaded) updateStatus(t("waitingForApp"));
      renderConnectionControls();
    };
    frame.src = getFrameUrl(target, options && options.path);
    updateSlowStatus();
    startAppReadyTimeout();
    renderConnectionControls();
  }

  window.__yepOpenNativePushPath = function (path) {
    if (typeof path !== "string" || path.charAt(0) !== "/") return;
    loadTarget(activeTarget || getStoredTarget() || targetFromChannel(DEFAULT_CHANNEL), {
      path: path,
      persist: false
    });
  };

  function postNativePushResponse(targetWindow, id, ok, result, error) {
    if (!targetWindow || !id) return;
    logNativePush(
      "post response id=" +
        id +
        " ok=" +
        (!!ok ? "true" : "false") +
        " error=" +
        (error || "null")
    );
    targetWindow.postMessage(
      {
        type: NATIVE_PUSH_RESPONSE_MESSAGE,
        id: id,
        ok: !!ok,
        result: result || null,
        error: error || null
      },
      "*"
    );
  }

  function takePendingNativePushFrame(id) {
    var targetWindow = pendingNativePushFrames[id];
    delete pendingNativePushFrames[id];
    if (pendingNativePushTimers[id]) {
      clearTimeout(pendingNativePushTimers[id]);
      delete pendingNativePushTimers[id];
    }
    return targetWindow;
  }

  function trackPendingNativePushFrame(id, targetWindow) {
    takePendingNativePushFrame(id);
    pendingNativePushFrames[id] = targetWindow;
    pendingNativePushTimers[id] = setTimeout(function () {
      var expiredTarget = takePendingNativePushFrame(id);
      logNativePush(
        "request expired id=" +
          id +
          " hasTarget=" +
          (!!expiredTarget ? "true" : "false")
      );
    }, NATIVE_PUSH_PENDING_TIMEOUT_MS);
  }

  window.__yepNativePushResolve = function (id, responseJson) {
    var targetWindow = takePendingNativePushFrame(id);
    logNativePush(
      "resolve from native id=" + id + " hasTarget=" + (!!targetWindow ? "true" : "false")
    );

    var response;
    try {
      response =
        typeof responseJson === "string"
          ? JSON.parse(responseJson)
          : responseJson;
    } catch (error) {
      logNativePush("resolve parse failed id=" + id);
      postNativePushResponse(
        targetWindow,
        id,
        false,
        null,
        "Invalid native push response"
      );
      return;
    }

    logNativePush(
      "resolve parsed id=" +
        id +
        " ok=" +
        (response && response.ok ? "true" : "false") +
        " error=" +
        ((response && response.error) || "null")
    );
    postNativePushResponse(
      targetWindow,
      id,
      response && response.ok,
      response && response.result,
      response && response.error
    );
  };

  function handleNativePushRequest(event) {
    var data = event.data || {};
    var id = typeof data.id === "string" ? data.id : null;
    var method = typeof data.method === "string" ? data.method : null;
    var bridge = window.YepNativePush;
    logNativePush(
      "request received id=" +
        (id || "null") +
        " method=" +
        (method || "null") +
        " hasBridge=" +
        (!!bridge ? "true" : "false")
    );

    if (!id || !method || !bridge) {
      postNativePushResponse(
        event.source,
        id,
        false,
        null,
        "Android native push bridge unavailable"
      );
      return;
    }

    var bridgeMethod =
      method === "status"
        ? "getStatus"
        : method === "requestPermission"
          ? "requestPermission"
          : method === "getToken"
            ? "getToken"
            : method === "uploadLogs"
              ? "uploadLogs"
              : null;

    if (!bridgeMethod || typeof bridge[bridgeMethod] !== "function") {
      logNativePush(
        "request unsupported id=" +
          id +
          " method=" +
          method +
          " bridgeMethod=" +
          (bridgeMethod || "null")
      );
      postNativePushResponse(
        event.source,
        id,
        false,
        null,
        "Unsupported native push method"
      );
      return;
    }

    trackPendingNativePushFrame(id, event.source);
    try {
      logNativePush("calling native method id=" + id + " bridgeMethod=" + bridgeMethod);
      bridge[bridgeMethod](id);
    } catch (error) {
      takePendingNativePushFrame(id);
      logNativePush(
        "native call threw id=" +
          id +
          " message=" +
          (error && error.message ? error.message : "unknown")
      );
      postNativePushResponse(
        event.source,
        id,
        false,
        null,
        error && error.message ? error.message : "Native push bridge failed"
      );
    }
  }

  function loadChannel(channel, options) {
    if (!isValidChannel(channel)) channel = DEFAULT_CHANNEL;
    loadTarget(targetFromChannel(channel), options);
  }

  function loadNode(value, options) {
    var target = targetFromNodeInput(value);
    if (!target) {
      updateNodeError(t("invalidNode"));
      return;
    }

    loadTarget(target, options);
  }

  function retryActiveTarget() {
    loadTarget(
      activeTarget || getStoredTarget() || targetFromChannel(DEFAULT_CHANNEL),
      { path: getCurrentFramePath(), persist: false }
    );
  }

  function useDefaultTarget() {
    removeStorage(ACTIVE_NODE_STORAGE_KEY);
    storeChannel(DEFAULT_CHANNEL);
    loadTarget(targetFromNodeInput(DEFAULT_TCP_ORIGIN), {
      path: getCurrentFramePath()
    });
  }

  function bindConnectionControls() {
    var form = document.querySelector("[data-node-form]");
    var input = document.querySelector("[data-node-input]");
    var httpButton = document.querySelector("[data-http-channel]");
    var retryButton = document.querySelector("[data-retry-connection]");
    var defaultButton = document.querySelector("[data-use-default]");
    var openSettingsButton = document.querySelector("[data-open-settings]");
    var closeSettingsButton = document.querySelector("[data-close-settings]");
    var copyDiagnosticsButton = document.querySelector("[data-copy-diagnostics]");
    var openAnywayButton = document.querySelector("[data-open-anyway]");

    if (form && input) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        loadNode(input.value, { path: getCurrentFramePath() });
      });

      input.addEventListener("input", function () {
        updateNodeError("");
      });
    }

    if (httpButton) {
      httpButton.addEventListener("click", function () {
        loadChannel("http", { path: getCurrentFramePath() });
      });
    }

    if (retryButton) retryButton.addEventListener("click", retryActiveTarget);
    if (defaultButton) defaultButton.addEventListener("click", useDefaultTarget);
    if (openSettingsButton) {
      openSettingsButton.addEventListener("click", openSettings);
    }
    if (closeSettingsButton) {
      closeSettingsButton.addEventListener("click", closeSettings);
    }
    if (copyDiagnosticsButton) {
      copyDiagnosticsButton.addEventListener("click", function () {
        copyDiagnostics(copyDiagnosticsButton);
      });
    }
    if (openAnywayButton) {
      openAnywayButton.addEventListener("click", openUnverifiedPage);
    }

    window.addEventListener("online", renderConnectionControls);
    window.addEventListener("offline", renderConnectionControls);

    renderConnectionControls();
  }

  function bindFrameLoad() {
    var frame = document.getElementById("app-frame");
    applyTranslations();
    if (frame) {
      window.addEventListener("message", function (event) {
        if (event.source !== frame.contentWindow) return;
        if (!event.data) return;

        if (event.data.type === NATIVE_PUSH_REQUEST_MESSAGE) {
          handleNativePushRequest(event);
          return;
        }

        if (event.data.type === NATIVE_PUSH_DEBUG_MESSAGE) {
          logNativePush("client: " + (event.data.message || ""));
          return;
        }

        if (event.data.type === APP_READY_MESSAGE) {
          if (activeTarget && event.origin !== activeTarget.origin) {
            logNativePush(
              "ignored app-ready from unexpected origin=" + event.origin
            );
            return;
          }
          markLoaded();
          postChannelStatus();
          return;
        }

        if (event.data.type === GET_CHANNEL_MESSAGE) {
          postChannelStatus();
          return;
        }

        if (event.data.type === SET_CHANNEL_MESSAGE) {
          var path = getFramePathFromMessage(event.data);
          var node = getNodeFromMessage(event.data);
          if (event.data.channel === "tcp" && node) {
            loadNode(node, { path: path });
          } else {
            loadChannel(event.data.channel, { path: path });
          }
        }
      });
    }
    bindConnectionControls();
    loadTarget(
      getRequestedTarget() ||
        getStoredTarget() ||
        targetFromChannel(DEFAULT_CHANNEL),
      { persist: false, path: getPendingNativePushPath() }
    );
  }

  window.addEventListener("hashchange", function () {
    loadTarget(activeTarget || targetFromChannel(DEFAULT_CHANNEL), {
      persist: false
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindFrameLoad, { once: true });
  } else {
    bindFrameLoad();
  }
})();
