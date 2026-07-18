import type { InputRequest, UserQuestionAnswers } from "@yep-anywhere/shared";
import type {
  BridgeController,
  BridgeInputResponse,
  BridgeSessionView,
} from "./types.js";

/**
 * Helpers for route handlers that aggregate multiple bridge controllers
 * (codex + opencode). Controllers are tried in order; absent ones are skipped.
 */
export type BridgeControllers = ReadonlyArray<BridgeController | undefined>;

export async function listAllBridgeSessionViews(
  controllers: BridgeControllers,
): Promise<BridgeSessionView[]> {
  const results = await Promise.all(
    controllers.map((controller) => controller?.listSessionViews() ?? []),
  );
  return results.flat();
}

export async function getAnyBridgeSessionView(
  controllers: BridgeControllers,
  sessionId: string,
): Promise<BridgeSessionView | null> {
  for (const controller of controllers) {
    const view = await controller?.getSessionView(sessionId);
    if (view) return view;
  }
  return null;
}

export async function isAnyBridgeSessionActive(
  controllers: BridgeControllers,
  sessionId: string,
): Promise<boolean> {
  for (const controller of controllers) {
    if (await controller?.isSessionActive(sessionId)) return true;
  }
  return false;
}

export async function getAnyBridgePendingInputRequest(
  controllers: BridgeControllers,
  sessionId: string,
): Promise<InputRequest | null> {
  for (const controller of controllers) {
    const request = await controller?.getPendingInputRequest(sessionId);
    if (request) return request;
  }
  return null;
}

export async function respondToAnyBridgeInput(
  controllers: BridgeControllers,
  sessionId: string,
  requestId: string,
  response: BridgeInputResponse,
  answers?: UserQuestionAnswers,
): Promise<boolean> {
  for (const controller of controllers) {
    try {
      if (
        await controller?.respondToInput(
          sessionId,
          requestId,
          response,
          answers,
        )
      ) {
        return true;
      }
    } catch (error) {
      // One bridge failing (e.g. an external OpenCode decision whose
      // confirmation timed out but remains queued for retry) must not 500
      // the route or mask the other bridge. The caller treats false as
      // "not accepted here"; clients re-check pending state.
      console.warn(
        `[bridge] respondToInput failed for session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return false;
}
