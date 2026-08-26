/**
 * Push notification API routes
 */

import { Hono } from "hono";
import type { NativePushService } from "./NativePushService.js";
import type { PushService } from "./PushService.js";
import type { NotificationSettings, PushSubscription } from "./types.js";

export interface PushRoutesDeps {
  pushService: PushService;
  nativePushService?: NativePushService;
}

interface SubscribeBody {
  browserProfileId: string;
  subscription: PushSubscription;
  deviceName?: string;
}

interface UnsubscribeBody {
  browserProfileId: string;
}

interface TestPushBody {
  browserProfileId: string;
  message?: string;
  urgency?: "normal" | "persistent" | "silent";
}

interface NativeSubscribeBody {
  browserProfileId: string;
  platform: "android";
  token: string;
  deviceName?: string;
}

export function createPushRoutes(deps: PushRoutesDeps): Hono {
  const app = new Hono();
  const { pushService, nativePushService } = deps;

  /**
   * GET /api/push/vapid-public-key
   * Returns the VAPID public key for client subscription
   */
  app.get("/vapid-public-key", (c) => {
    const publicKey = pushService.getPublicKey();

    if (!publicKey) {
      return c.json(
        {
          error: "VAPID keys not configured",
          hint: "Run 'pnpm setup-vapid' to generate keys",
        },
        503,
      );
    }

    return c.json({ publicKey });
  });

  /**
   * POST /api/push/subscribe
   * Subscribe a browser profile for push notifications
   */
  app.post("/subscribe", async (c) => {
    const body = await c.req.json<SubscribeBody>();

    if (!body.browserProfileId || typeof body.browserProfileId !== "string") {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    if (!body.subscription?.endpoint || !body.subscription?.keys) {
      return c.json({ error: "Valid subscription object is required" }, 400);
    }

    const userAgent = c.req.header("User-Agent");

    await pushService.subscribe(body.browserProfileId, body.subscription, {
      userAgent,
      deviceName: body.deviceName,
    });

    return c.json({
      success: true,
      browserProfileId: body.browserProfileId,
    });
  });

  /**
   * POST /api/push/unsubscribe
   * Unsubscribe a browser profile from push notifications
   */
  app.post("/unsubscribe", async (c) => {
    const body = await c.req.json<UnsubscribeBody>();

    if (!body.browserProfileId || typeof body.browserProfileId !== "string") {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    const removed = await pushService.unsubscribe(body.browserProfileId);

    return c.json({
      success: removed,
      browserProfileId: body.browserProfileId,
    });
  });

  /**
   * GET /api/push/subscriptions
   * List all push subscriptions (for settings UI)
   */
  app.get("/subscriptions", (c) => {
    const subscriptions = pushService.getSubscriptions();
    const nativeSubscriptions = nativePushService?.getSubscriptions() ?? {};

    // Include the original subscription for the authenticated owner.
    const sanitized = Object.entries(subscriptions).map(
      ([browserProfileId, sub]) => {
        // Safely extract domain from endpoint
        let endpointDomain = "unknown";
        try {
          if (sub.subscription?.endpoint) {
            endpointDomain = new URL(sub.subscription.endpoint).hostname;
          }
        } catch {
          // Invalid URL, keep "unknown"
        }

        return {
          browserProfileId,
          subscription: sub.subscription,
          createdAt: sub.createdAt,
          deviceName: sub.deviceName,
          endpointDomain,
          pushKind: "web" as const,
        };
      },
    );

    const nativeSanitized = Object.entries(nativeSubscriptions).map(
      ([browserProfileId, sub]) => ({
        browserProfileId,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
        deviceName: sub.deviceName,
        endpointDomain: "fcm.googleapis.com",
        platform: sub.platform,
        pushKind: "native" as const,
      }),
    );

    return c.json({
      count: sanitized.length + nativeSanitized.length,
      subscriptions: [...sanitized, ...nativeSanitized],
    });
  });

  /**
   * DELETE /api/push/subscriptions/:browserProfileId
   * Remove a specific subscription
   */
  app.delete("/subscriptions/:browserProfileId", async (c) => {
    const browserProfileId = c.req.param("browserProfileId");
    const removed = await pushService.unsubscribe(browserProfileId);

    if (!removed) {
      return c.json({ error: "Subscription not found" }, 404);
    }

    return c.json({ success: true });
  });

  /**
   * POST /api/push/test
   * Send a test notification (for debugging)
   */
  app.post("/test", async (c) => {
    const body = await c.req.json<TestPushBody>();

    if (!body.browserProfileId) {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    const result = await pushService.sendTest(
      body.browserProfileId,
      body.message ?? "Test notification from Yep Anywhere",
      body.urgency,
    );

    if (!result.success) {
      return c.json(
        {
          success: false,
          error: result.error,
          statusCode: result.statusCode,
        },
        result.statusCode === 404 || result.statusCode === 410 ? 410 : 500,
      );
    }

    return c.json({ success: true });
  });

  /**
   * GET /api/push/native/status
   * Returns whether native push is configured server-side.
   */
  app.get("/native/status", (c) => {
    return c.json({
      configured: nativePushService?.isConfigured() ?? false,
    });
  });

  /**
   * POST /api/push/native/subscribe
   * Subscribe an Android FCM token for native push notifications.
   */
  app.post("/native/subscribe", async (c) => {
    if (!nativePushService) {
      return c.json({ error: "Native push service not available" }, 503);
    }

    const body = await c.req.json<NativeSubscribeBody>();

    if (!body.browserProfileId || typeof body.browserProfileId !== "string") {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    if (body.platform !== "android") {
      return c.json({ error: "platform must be android" }, 400);
    }

    if (!body.token || typeof body.token !== "string") {
      return c.json({ error: "token is required" }, 400);
    }

    await nativePushService.subscribe(body.browserProfileId, body.token, {
      deviceName: body.deviceName,
    });

    return c.json({
      success: true,
      browserProfileId: body.browserProfileId,
    });
  });

  /**
   * POST /api/push/native/unsubscribe
   * Unsubscribe an Android native push profile.
   */
  app.post("/native/unsubscribe", async (c) => {
    if (!nativePushService) {
      return c.json({ error: "Native push service not available" }, 503);
    }

    const body = await c.req.json<UnsubscribeBody>();

    if (!body.browserProfileId || typeof body.browserProfileId !== "string") {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    const removed = await nativePushService.unsubscribe(body.browserProfileId);

    return c.json({
      success: removed,
      browserProfileId: body.browserProfileId,
    });
  });

  /**
   * POST /api/push/native/test
   * Send a test notification through native push.
   */
  app.post("/native/test", async (c) => {
    if (!nativePushService) {
      return c.json({ error: "Native push service not available" }, 503);
    }

    const body = await c.req.json<TestPushBody>();

    if (!body.browserProfileId) {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    const result = await nativePushService.sendTest(
      body.browserProfileId,
      body.message ?? "Test notification from Yep Anywhere",
      body.urgency,
    );

    if (!result.success) {
      return c.json(
        {
          success: false,
          error: result.error,
          statusCode: result.statusCode,
        },
        result.statusCode === 404 || result.statusCode === 410 ? 410 : 500,
      );
    }

    return c.json({ success: true });
  });

  /**
   * DELETE /api/push/native/subscriptions/:browserProfileId
   * Remove a specific native push subscription.
   */
  app.delete("/native/subscriptions/:browserProfileId", async (c) => {
    if (!nativePushService) {
      return c.json({ error: "Native push service not available" }, 503);
    }

    const browserProfileId = c.req.param("browserProfileId");
    const removed = await nativePushService.unsubscribe(browserProfileId);

    if (!removed) {
      return c.json({ error: "Subscription not found" }, 404);
    }

    return c.json({ success: true });
  });

  /**
   * GET /api/push/settings
   * Get notification settings (what types of notifications are sent)
   */
  app.get("/settings", (c) => {
    const settings = pushService.getNotificationSettings();
    return c.json({ settings });
  });

  /**
   * PUT /api/push/settings
   * Update notification settings
   */
  app.put("/settings", async (c) => {
    const body = await c.req.json<Partial<NotificationSettings>>();

    // Validate that we got at least one setting
    const validKeys = [
      "toolApproval",
      "userQuestion",
      "sessionHalted",
    ] as const;
    const updates: Partial<NotificationSettings> = {};

    for (const key of validKeys) {
      if (typeof body[key] === "boolean") {
        updates[key] = body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "At least one valid setting is required" }, 400);
    }

    const settings = await pushService.setNotificationSettings(updates);
    return c.json({ settings });
  });

  return app;
}
