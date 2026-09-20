import { fallbackRenderer } from "./blocks/FallbackRenderer";
import { textRenderer } from "./blocks/TextRenderer";
import { thinkingRenderer } from "./blocks/ThinkingRenderer";
import { toolResultRenderer } from "./blocks/ToolResultRenderer";
import { toolUseRenderer } from "./blocks/ToolUseRenderer";
import { RendererRegistry } from "./registry";

// Create and configure the registry
export const registry = new RendererRegistry(fallbackRenderer);

// Register content block renderers
registry.register(textRenderer);
registry.register(thinkingRenderer);
registry.register(toolUseRenderer);
registry.register(toolResultRenderer);
