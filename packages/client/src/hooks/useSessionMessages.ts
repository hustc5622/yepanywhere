import { useLegacySessionMessages } from "./useLegacySessionMessages";
import type { UseSessionMessagesOptions } from "./useLegacySessionMessages";
import { useProjectedSessionMessages } from "./useProjectedSessionMessages";
export {
  planActiveMessageWindowTrim,
  truncateMessagesForEdit,
} from "./useLegacySessionMessages";
export type {
  AgentContent,
  AgentContentMap,
  SessionLoadResult,
  UseSessionMessagesOptions,
  UseSessionMessagesResult,
} from "./useLegacySessionMessages";

/** A view uses one complete transport/model; legacy is an explicit URL opt-out. */
export function useSessionMessages(options: UseSessionMessagesOptions) {
  const projected = options.preferDisplayHistory === true;
  const legacy = useLegacySessionMessages({
    ...options,
    enabled: !projected,
    preferDisplayHistory: false,
  });
  const display = useProjectedSessionMessages({
    ...options,
    enabled: projected,
  });
  return projected
    ? display
    : {
        ...legacy,
        displayActivity: undefined,
        handleDisplayEvent: (_type: string, _data: unknown) => {},
      };
}
