import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import enMessages from "../../i18n/en.json";
import { useProviderPermissionModeConfig } from "../useProviderPermissionModeConfig";

function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

describe("useProviderPermissionModeConfig", () => {
  it("uses Pi-specific approval copy", () => {
    const pi = renderHook(() => useProviderPermissionModeConfig("pi"), {
      wrapper,
    }).result.current;
    expect(pi.title).toBe(enMessages.newSessionPiPermissionTitle);
    expect(pi.description).toBe(enMessages.newSessionPiPermissionDescription);
  });

  it("describes Pi's plan mode as an approval gate without a plan prompt", () => {
    const { result } = renderHook(() => useProviderPermissionModeConfig("pi"), {
      wrapper,
    });

    expect(result.current.labels.plan).toBe(enMessages.modePiPlanLabel);
    expect(result.current.descriptions.plan).toBe(
      enMessages.modePiPlanDescription,
    );
    expect(result.current.descriptions.plan).toContain("no native plan mode");
  });
});
