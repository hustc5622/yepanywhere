import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJSON } from "../../api/client";
import { FeishuAuthorizationSettings } from "./FeishuAuthorizationSettings";

vi.mock("../../api/client", () => ({ fetchJSON: vi.fn() }));
vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

describe("Feishu authorization settings", () => {
  let connected: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    connected = false;
    vi.mocked(fetchJSON).mockImplementation(async (path, options) => {
      if (path.endsWith("/accounts"))
        return {
          accounts: [
            {
              id: "bot",
              name: "Team bot",
              allowedUsers: ["ou_user"],
              userAuth: {
                enabled: true,
                redirectUri: "https://yep.test/api/auth/feishu/callback",
                scopes: ["offline_access"],
              },
            },
          ],
        };
      if (path.endsWith("/action")) {
        connected = true;
        return { authorizationUrl: "https://accounts.feishu.cn/authorize" };
      }
      if (options?.method === "PUT") return { account: {} };
      return {
        users: [
          {
            accountId: "bot",
            userOpenId: "ou_user",
            status: "not_connected",
            scopes: [],
            ...(connected
              ? { authorizationUrl: "https://accounts.feishu.cn/authorize" }
              : {}),
          },
        ],
      };
    });
  });
  it("opens a provider authorization link after creating an attempt", async () => {
    render(<FeishuAuthorizationSettings />);
    await screen.findByText("Team bot");
    fireEvent.click(screen.getByText("feishuAuthConnect"));
    const link = await screen.findByRole("link", { name: "feishuAuthOpen" });
    expect(link.getAttribute("href")).toBe(
      "https://accounts.feishu.cn/authorize",
    );
    expect(vi.mocked(fetchJSON)).toHaveBeenCalledWith(
      "/channels/feishu/accounts/bot/user-auth/ou_user/action",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "connect" }),
      }),
    );
  });
  it("saves the callback and scopes without overwriting other account settings", async () => {
    render(<FeishuAuthorizationSettings />);
    await screen.findByText("Team bot");
    fireEvent.change(screen.getByLabelText("feishuAuthCallback"), {
      target: { value: "https://new.test/yep/api/auth/feishu/callback" },
    });
    fireEvent.change(screen.getByLabelText("feishuAuthScopes"), {
      target: { value: "offline_access\ndrive:file:download" },
    });
    fireEvent.click(screen.getByText("feishuAuthSave"));
    await waitFor(() =>
      expect(vi.mocked(fetchJSON)).toHaveBeenCalledWith(
        "/channels/feishu/accounts/bot/user-auth",
        {
          method: "PUT",
          body: JSON.stringify({
            enabled: true,
            redirectUri: "https://new.test/yep/api/auth/feishu/callback",
            scopes: ["offline_access", "drive:file:download"],
          }),
        },
      ),
    );
  });
});
