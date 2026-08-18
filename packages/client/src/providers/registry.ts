import { ClaudeProvider } from "./implementations/ClaudeProvider";
import {
  CodexOssProvider,
  CodexProvider,
} from "./implementations/CodexProvider";
import { GeminiACPProvider } from "./implementations/GeminiACPProvider";
import { GeminiProvider } from "./implementations/GeminiProvider";
import { KimiProvider } from "./implementations/KimiProvider";
import { PiProvider } from "./implementations/PiProvider";
import { ZCodeProvider } from "./implementations/ZCodeProvider";
import type { Provider, ProviderMetadata } from "./types";

const activeProviders: Record<string, Provider> = {
  gemini: new GeminiProvider(),
  "gemini-acp": new GeminiACPProvider(),
  codex: new CodexProvider(),
  "codex-oss": new CodexOssProvider(),
  pi: new PiProvider(),
  kimi: new KimiProvider(),
  zcode: new ZCodeProvider(),
};

const providers: Record<string, Provider> = {
  // Retain Claude capabilities for rendering historical sessions, but keep the
  // retired SSH channel out of settings and new-session provider discovery.
  claude: new ClaudeProvider(),
  ...activeProviders,
};

/**
 * Get all active providers for settings display.
 */
export function getAllProviders(): Provider[] {
  return Object.values(activeProviders);
}

/**
 * Fallback provider for unknown IDs.
 * Assumes minimal capabilities (no DAG, no cloning).
 */
class GenericProvider implements Provider {
  readonly capabilities = {
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata;

  constructor(readonly id: string) {
    this.metadata = {
      description: "Unknown provider",
      limitations: [],
      website: "",
      cliName: id,
    };
  }

  get displayName(): string {
    return this.id;
  }
}

/**
 * Get a provider instance by ID.
 * Returns a generic provider with safe defaults if ID is unknown.
 */
export function getProvider(id: string | undefined): Provider {
  if (!id) {
    return new GenericProvider("unknown");
  }
  return providers[id] ?? new GenericProvider(id);
}
