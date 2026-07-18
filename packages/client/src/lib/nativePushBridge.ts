const REQUEST_MESSAGE = "yep-anywhere:native-push-request";
const RESPONSE_MESSAGE = "yep-anywhere:native-push-response";
const DEBUG_MESSAGE = "yep-anywhere:native-push-debug";
const REQUEST_TIMEOUT_MS: Record<NativePushMethod, number> = {
  status: 8000,
  requestPermission: 30000,
  getToken: 15000,
  // Uploading a full native ring buffer can take several batches on a slow
  // link (up to ~1000 entries in 500-entry POSTs).
  uploadLogs: 60000,
};

export type NativePushPermissionState =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

export interface NativePushStatus {
  supported: boolean;
  permission: NativePushPermissionState;
}

export interface NativePushTokenResult {
  token: string;
}

export interface NativeLogUploadResult {
  uploaded: number;
}

type NativePushMethod =
  | "status"
  | "requestPermission"
  | "getToken"
  | "uploadLogs";

interface NativePushResponse<T> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

let nextRequestId = 1;

export function isMobileShellDocument(): boolean {
  return document.documentElement.dataset.mobileShell === "true";
}

export function debugNativePush(message: string): void {
  try {
    if (isMobileShellDocument() && window.parent !== window) {
      window.parent.postMessage({ type: DEBUG_MESSAGE, message }, "*");
      return;
    }
  } catch {
    // Best-effort diagnostics only.
  }

  console.log(`[NativePush] ${message}`);
}

export async function getNativePushStatus(): Promise<NativePushStatus> {
  return invokeNativePush<NativePushStatus>("status");
}

export async function requestNativePushPermission(): Promise<NativePushStatus> {
  return invokeNativePush<NativePushStatus>("requestPermission");
}

export async function getNativePushToken(): Promise<NativePushTokenResult> {
  return invokeNativePush<NativePushTokenResult>("getToken");
}

/** Upload the Android shell's native diagnostic log buffer to the server. */
export async function uploadNativeLogs(): Promise<NativeLogUploadResult> {
  return invokeNativePush<NativeLogUploadResult>("uploadLogs");
}

function invokeNativePush<T>(method: NativePushMethod): Promise<T> {
  if (!isMobileShellDocument() || window.parent === window) {
    debugNativePush(`invoke skipped method=${method} unavailable`);
    return Promise.reject(new Error("Android native push is not available"));
  }

  const id = `native-push-${Date.now()}-${nextRequestId++}`;
  debugNativePush(`invoke start id=${id} method=${method}`);

  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      debugNativePush(`invoke timeout id=${id} method=${method}`);
      reject(new Error("Android native push bridge timed out"));
    }, REQUEST_TIMEOUT_MS[method]);

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as NativePushResponse<T> & { type?: unknown };
      if (!data || data.type !== RESPONSE_MESSAGE || data.id !== id) return;

      window.clearTimeout(timer);
      window.removeEventListener("message", handleMessage);
      debugNativePush(
        `invoke response id=${id} method=${method} ok=${data.ok ? "true" : "false"} error=${data.error || "null"}`,
      );

      if (data.ok) {
        resolve(data.result as T);
      } else {
        reject(new Error(data.error || "Android native push bridge failed"));
      }
    };

    window.addEventListener("message", handleMessage);
    window.parent.postMessage({ type: REQUEST_MESSAGE, id, method }, "*");
    debugNativePush(`invoke posted id=${id} method=${method}`);
  });
}
