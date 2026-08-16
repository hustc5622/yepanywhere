/** Mock Pi provider for provider-agnostic runtime tests. */

import type { ProviderName } from "../types.js";
import { BaseMockProvider } from "./base.js";
import type { MockProviderConfig } from "./types.js";

export class MockPiProvider extends BaseMockProvider {
  readonly name: ProviderName = "pi";
  readonly displayName = "Pi";

  constructor(config: MockProviderConfig = {}) {
    super(config);
  }
}
