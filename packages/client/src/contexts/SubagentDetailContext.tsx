import { createContext, useContext } from "react";

export interface SubagentDetailTarget {
  agentId: string;
  /** The immediate parent, not the root shared by every thread in the tree. */
  parentSessionId?: string;
  name?: string;
  status?: string;
}

export interface SubagentDetailContextValue {
  openAgent: (target: SubagentDetailTarget) => void;
  /** Status from a visible child detail whose polling has not failed. */
  statuses: Record<string, string>;
}

export const SubagentDetailContext =
  createContext<SubagentDetailContextValue | null>(null);

export function useSubagentDetail() {
  return useContext(SubagentDetailContext);
}
