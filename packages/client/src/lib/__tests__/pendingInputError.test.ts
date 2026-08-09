import { describe, expect, it } from "vitest";
import { isStalePendingInputError } from "../pendingInputError";

function apiError(
  status: number,
  message?: string,
  code?: string,
): Error & { status: number; code?: string } {
  const err = new Error(message ?? `Error ${status}`) as Error & {
    status: number;
    code?: string;
  };
  err.status = status;
  err.code = code;
  return err;
}

describe("isStalePendingInputError", () => {
  it("treats 404 (bridge process, no active session) as stale", () => {
    expect(isStalePendingInputError(apiError(404, "No active process"))).toBe(
      true,
    );
  });

  it("treats owned-process 400 'No pending input request' as stale", () => {
    expect(
      isStalePendingInputError(apiError(400, "No pending input request")),
    ).toBe(true);
  });

  it("treats owned-process 400 'Invalid request ID or no pending request' as stale", () => {
    expect(
      isStalePendingInputError(
        apiError(400, "Invalid request ID or no pending request"),
      ),
    ).toBe(true);
  });

  it("does not treat unrelated 400 errors as stale", () => {
    expect(
      isStalePendingInputError(
        apiError(400, "requestId and response are required"),
      ),
    ).toBe(false);
    expect(isStalePendingInputError(apiError(400, "Invalid JSON body"))).toBe(
      false,
    );
  });

  it("treats central broker CAS conflicts as stale", () => {
    expect(
      isStalePendingInputError(
        apiError(
          409,
          "Interaction already resolved",
          "interaction_already_resolved",
        ),
      ),
    ).toBe(true);
    expect(
      isStalePendingInputError(
        apiError(
          409,
          "Interaction version is stale",
          "interaction_stale_version",
        ),
      ),
    ).toBe(true);
    expect(isStalePendingInputError(apiError(409, "Conflict"))).toBe(false);
  });

  it("does not treat server/other errors as stale", () => {
    expect(isStalePendingInputError(apiError(500))).toBe(false);
    expect(isStalePendingInputError(apiError(403))).toBe(false);
    expect(isStalePendingInputError(new Error("network"))).toBe(false);
    expect(isStalePendingInputError(undefined)).toBe(false);
  });
});
