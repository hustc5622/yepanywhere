export function executeTool(
  sdk: object,
  name: string,
  args: Record<string, unknown>,
  opts: unknown,
  context: { workspace: string; roots: string[] },
): Promise<unknown>;
