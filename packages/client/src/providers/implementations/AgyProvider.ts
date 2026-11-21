import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

/**
 * Client-side provider for Google Antigravity CLI (`agy acp`).
 *
 * Antigravity CLI is Gemini CLI's successor for personal Google accounts.
 * Conversations live in `~/.gemini/antigravity-cli`, so sessions started in a
 * terminal `agy` are listed here and can be continued.
 */
export class AgyProvider implements Provider {
  readonly id = "agy";
  readonly displayName = "Antigravity";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Google Antigravity CLI via Agent Client Protocol. Lists conversations from the CLI and can continue them.",
    limitations: [
      "Requires the Antigravity CLI (`agy`) signed in once on the Yep host",
      "Editing, rewinding or forking earlier messages is not available over ACP",
      "Assistant text appears per step instead of streaming token by token",
    ],
    website: "https://antigravity.google/docs/cli/using",
    cliName: "agy",
  };
}
