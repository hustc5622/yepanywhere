import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

/**
 * Client-side provider for read-only DeepSeek Harness sessions.
 *
 * Yep lists and displays sessions from `~/.dsh`; continuing a conversation
 * happens in the embedded dsh Web UI, which owns every mutation.
 */
export class DshProvider implements Provider {
  readonly id = "dsh";
  readonly displayName = "dsh";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "DeepSeek Harness sessions, shown read-only. Open the embedded dsh page to continue a conversation.",
    limitations: [
      "Read-only in Yep: messages are sent from the dsh page",
      "Subagent transcripts are not linked yet",
    ],
    website: "https://github.com/deepseek-ai/deepseek-harness",
    cliName: "dsh",
  };
}
