import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

/** Client-side metadata and transcript capabilities for Pi coding agent. */
export class PiProvider implements Provider {
  readonly id = "pi";
  readonly displayName = "Pi";

  readonly capabilities: ProviderCapabilities = {
    // Yep receives an already projected active branch from Pi's native JSONL
    // tree. Historical edits create sibling native sessions, not client-side
    // DAG clones.
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Pi coding agent via its native JSONL RPC mode, with gateway model selection, streaming, and Yep-managed tool approvals.",
    limitations: [
      "Requires @earendil-works/pi-coding-agent with RPC mode support",
      "Full-session cloning is not supported; branches are created by editing a persisted user prompt",
    ],
    website: "https://pi.dev",
    cliName: "pi",
  };
}
