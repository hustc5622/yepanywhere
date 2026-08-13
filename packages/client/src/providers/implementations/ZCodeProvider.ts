import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

/**
 * Client-side provider for ZCode Agent via `app-server` JSON-RPC over stdio.
 *
 * ZCode runs through `zcode app-server`, executing its own tools and routing
 * sensitive operations through Yep's approval flow. Historical prompt edits
 * create provider-native forks, while full-session cloning and a client-side
 * DAG remain unsupported.
 */
export class ZCodeProvider implements Provider {
  readonly id = "zcode";
  readonly displayName = "ZCode";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "ZCode Agent via built-in CLI app-server. Full agentic capabilities with server-side tool execution, permission routing, and session lifecycle control.",
    limitations: [
      "Requires ZCode Desktop with built-in CLI (app-server mode)",
      "Full-session cloning is not supported; branches are created by editing a persisted user prompt",
      "External TUI approvals require the optional Yep bridge plugin",
    ],
    website: "https://zcode.z.ai",
    cliName: "zcode",
  };
}
