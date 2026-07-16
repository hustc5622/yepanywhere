import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class ClaudeProvider implements Provider {
  readonly id = "claude";
  readonly displayName = "Claude Code (SSH)";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: true,
    // The VM's JSONL is authoritative. A local-only clone cannot be resumed
    // remotely until clone propagation is implemented.
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Official Claude Code CLI running in a configured SSH executor, with projects shared from the Yep host.",
    limitations: [
      "Claude sessions require a configured remote executor and shared path mapping.",
      "Cloning remote Claude sessions is not yet supported.",
    ],
    website: "https://docs.anthropic.com/en/docs/claude-code",
    cliName: "claude",
  };
}
