import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

/**
 * Client-side provider for Kimi Code CLI via Agent Client Protocol.
 *
 * Kimi runs through `kimi acp`, executing its own tools and routing sensitive
 * operations through Yep's approval flow. Session content edits (fork/branch)
 * are not exposed over ACP, so DAG/cloning are disabled.
 */
export class KimiProvider implements Provider {
  readonly id = "kimi";
  readonly displayName = "Kimi";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Moonshot's Kimi Code CLI via Agent Client Protocol. Full agentic capabilities with server-side tool execution and approval routing.",
    limitations: [
      "Requires the kimi CLI with `kimi acp` support",
      "Session fork/branch not available over ACP",
    ],
    website: "https://moonshotai.github.io/kimi-code/",
    cliName: "kimi",
  };
}
