import type { InputRequest, UserQuestionAnswers } from "@yep-anywhere/shared";
import { isActiveBridgeSessionView } from "./session-state.js";
import type {
  BridgeController,
  BridgeInputResolutionContext,
  BridgeInputResponse,
  BridgeSessionView,
} from "./types.js";

/**
 * Helpers for route handlers that aggregate bridge controllers. Controllers
 * are tried in order; absent ones are skipped.
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

/**
 * Live bridge sessions taken straight from the bulk `/session-views`
 * snapshots, without a per-session round-trip.
 *
 * Each snapshot entry already carries the sidecar's own liveness verdict
 * (`BridgeSessionView.active`) - the same answer `/sessions/:id/active` would
 * give. Asking the sidecar again per session turned a project listing into
 * `1 + sessions x 2` bridge requests (~300 sockets for ~148 sessions), and
 * each extra request can trigger expensive upstream reconciliation. Callers
 * that need liveness for a whole
 * list must therefore filter the snapshot in memory.
 */
export async function listActiveBridgeSessionViews(
  controllers: BridgeControllers,
): Promise<BridgeSessionView[]> {
  const views = await listAllBridgeSessionViews(controllers);
  return views.filter((view) => isActiveBridgeSessionView(view));
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
  context: BridgeInputResolutionContext,
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
          context,
        )
      ) {
        return true;
      }
    } catch (error) {
      // One bridge failing must not 500 the route or mask another bridge. The
      // caller treats false as
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
