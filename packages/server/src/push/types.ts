/**
 * Push notification types
 */

/** Web Push subscription from the browser's PushManager */
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** Stored subscription with metadata */
export interface StoredSubscription {
  /** The push subscription from the browser */
  subscription: PushSubscription;
  /** When this subscription was created */
  createdAt: string;
  /** User agent of the subscribing browser */
  userAgent?: string;
  /** Optional friendly name for the device */
  deviceName?: string;
}

/** Server-side notification settings (controls what types of notifications are sent) */
export interface NotificationSettings {
  /** Send notifications for tool approval requests */
  toolApproval: boolean;
  /** Send notifications for user questions */
  userQuestion: boolean;
  /** Send notifications when sessions halt/complete */
  sessionHalted: boolean;
}

/** Default notification settings (all enabled) */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  toolApproval: true,
  userQuestion: true,
  sessionHalted: true,
};

/** Subscription storage state */
export interface SubscriptionState {
  /** Schema version for future migrations */
  version: number;
  /** Map of browserProfileId -> subscription info */
  subscriptions: Record<string, StoredSubscription>;
  /** Server-side notification type settings */
  settings?: NotificationSettings;
}

/** Native mobile push platform. */
export type NativePushPlatform = "android";

/** Stored native mobile push subscription with metadata. */
export interface StoredNativePushSubscription {
  platform: NativePushPlatform;
  /** FCM registration token for Android. */
  token: string;
  /** When this subscription was first created. */
  createdAt: string;
  /** When this subscription was last updated. */
  updatedAt: string;
  /** Optional friendly name for the device. */
  deviceName?: string;
}

/** Native push subscription storage state. */
export interface NativePushSubscriptionState {
  /** Schema version for future migrations. */
  version: number;
  /** Map of browserProfileId -> native subscription info. */
  subscriptions: Record<string, StoredNativePushSubscription>;
}

/** Push notification payload types */
export type PushPayloadType =
  | "pending-input"
  | "session-halted"
  | "dismiss"
  | "test";

/** Base push payload */
interface BasePushPayload {
  type: PushPayloadType;
  timestamp: string;
}

/** Notification for pending input (approval/question) */
export interface PendingInputPayload extends BasePushPayload {
  type: "pending-input";
  sessionId: string;
  projectId: string;
  projectName: string;
  /** Optional session display title for native notification surfaces. */
  sessionTitle?: string;
  inputType: "tool-approval" | "user-question";
  /** Brief generic summary of the pending input. */
  summary: string;
  /** Present only for tool approvals that support notification actions. */
  requestId?: string;
}

/** Notification for session that stopped working */
export interface SessionHaltedPayload extends BasePushPayload {
  type: "session-halted";
  sessionId: string;
  projectId: string;
  projectName: string;
  /** Optional session display title for native notification surfaces. */
  sessionTitle?: string;
  reason: "completed" | "error" | "idle";
  /** How long the session was running (ms) */
  duration: number;
}

/** Dismiss notification on other devices */
export interface DismissPayload extends BasePushPayload {
  type: "dismiss";
  sessionId: string;
}

/** Test notification urgency levels */
export type TestNotificationUrgency = "normal" | "persistent" | "silent";

/** Test notification */
export interface TestPayload extends BasePushPayload {
  type: "test";
  message: string;
  /** Controls notification behavior: normal (auto-dismiss), persistent (stays visible), silent (no sound) */
  urgency?: TestNotificationUrgency;
}

export type PushPayload =
  | PendingInputPayload
  | SessionHaltedPayload
  | DismissPayload
  | TestPayload;

/** Result of sending a push notification */
export interface SendResult {
  browserProfileId: string;
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** HTTP status code from push service */
  statusCode?: number;
}
