import { createContext, useContext } from "react";

/**
 * Lets deeply-nested message components (e.g. TextBlock) open a file in the
 * same VS Code-style editor tab used by the project repo explorer, instead of
 * spawning a separate modal. Provided by SessionPage (which owns the tab
 * state). Components that are not rendered inside SessionPage get `null` and
 * should fall back to their previous behavior.
 */
export interface FileTabOpener {
  /** Open a project-relative file path in an editor tab. */
  openFileTab: (relativePath: string) => void;
}

export const FileTabOpenerContext = createContext<FileTabOpener | null>(null);

export function useFileTabOpener(): FileTabOpener | null {
  return useContext(FileTabOpenerContext);
}
