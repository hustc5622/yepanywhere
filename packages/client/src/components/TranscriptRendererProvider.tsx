import type { ReactNode } from "react";
import {
  NestedRendererContext,
  type NestedRenderers,
} from "../contexts/NestedRendererContext";
import { RenderItemComponent } from "./RenderItemComponent";
import { ContentBlockRenderer } from "./renderers/ContentBlockRenderer";

const renderers: NestedRenderers = {
  RenderItem: RenderItemComponent,
  ContentBlock: ContentBlockRenderer,
};

/** Composition belongs above the renderer registry, outside its dependency graph. */
export function TranscriptRendererProvider({
  children,
}: { children: ReactNode }) {
  return (
    <NestedRendererContext.Provider value={renderers}>
      {children}
    </NestedRendererContext.Provider>
  );
}
