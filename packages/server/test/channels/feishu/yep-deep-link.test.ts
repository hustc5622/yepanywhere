import { describe, expect, it } from "vitest";
import { buildYepFeishuTurnDeepLink } from "../../../src/channels/feishu/yep-deep-link.js";

const TURN_REFERENCE = "feishu-0123456789abcdef0123456789abcdef";

describe("buildYepFeishuTurnDeepLink", () => {
  it("builds a locator URL from an explicit public HTTPS base", () => {
    expect(
      buildYepFeishuTurnDeepLink({
        publicBaseUrl: "https://yep.example.com/yep/",
        turnReference: TURN_REFERENCE,
      }),
    ).toEqual({
      state: "available",
      url: `https://yep.example.com/yep/sessions/${TURN_REFERENCE}`,
    });
  });

  it.each([undefined, ""])(
    "returns typed unavailable when no public origin is configured",
    (url) => {
      expect(
        buildYepFeishuTurnDeepLink({
          publicBaseUrl: url,
          turnReference: TURN_REFERENCE,
        }),
      ).toEqual({
        state: "unavailable",
        reason: "public_origin_unconfigured",
      });
    },
  );

  it.each([
    "http://yep.example.com/yep",
    "https://localhost/yep",
    "https://127.0.0.1:8022/yep",
    "https://10.0.0.8/yep",
    "https://[::1]/yep",
    "https://user:password@yep.example.com/yep",
    "https://yep.example.com/yep?token=secret",
    "https://yep.example.com/yep#redirect",
    "https://yep.example.com/yep%2F..%2Fadmin",
  ])("rejects an unsafe or ambiguous configured base: %s", (url) => {
    expect(
      buildYepFeishuTurnDeepLink({
        publicBaseUrl: url,
        turnReference: TURN_REFERENCE,
      }),
    ).toEqual({ state: "unavailable", reason: "public_origin_unsafe" });
  });

  it("never treats a provider session id or path as a turn reference", () => {
    for (const turnReference of [
      "thread-secret",
      "../../sessions/thread-secret",
      `${TURN_REFERENCE}?token=secret`,
    ]) {
      expect(
        buildYepFeishuTurnDeepLink({
          publicBaseUrl: "https://yep.example.com/yep",
          turnReference,
        }),
      ).toEqual({
        state: "unavailable",
        reason: "turn_reference_unavailable",
      });
    }
  });
});
