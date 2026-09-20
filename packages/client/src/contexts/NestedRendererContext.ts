import { type ComponentType, createContext, useContext } from "react";
import type {
  ContentBlock,
  RenderContext,
} from "../components/renderers/types";
import type { RenderItem } from "../types/renderItems";

export interface NestedRenderers {
  RenderItem: ComponentType<{
    item: RenderItem;
    isStreaming: boolean;
    thinkingExpanded: boolean;
    toggleThinkingExpanded: (id: string) => void;
  }>;
  ContentBlock: ComponentType<{ block: ContentBlock; context: RenderContext }>;
}

export const NestedRendererContext = createContext<NestedRenderers | null>(
  null,
);

export function useNestedRenderers(): NestedRenderers {
  const renderers = useContext(NestedRendererContext);
  if (!renderers)
    throw new Error("Nested transcript requires TranscriptRendererProvider");
  return renderers;
}
