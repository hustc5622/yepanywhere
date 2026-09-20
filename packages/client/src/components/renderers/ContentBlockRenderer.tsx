import { memo } from "react";
import { registry } from "./configuredRegistry";
import type { ContentBlock, RenderContext } from "./types";

interface Props {
  block: ContentBlock;
  context: RenderContext;
}

/**
 * Dispatcher component that renders a content block using the appropriate renderer
 */
export const ContentBlockRenderer = memo(function ContentBlockRenderer({
  block,
  context,
}: Props) {
  return <>{registry.render(block, context)}</>;
});
