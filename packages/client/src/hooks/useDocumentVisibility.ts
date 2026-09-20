import { useSyncExternalStore } from "react";

const subscribe = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
};
const visible = () => document.visibilityState === "visible";

export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(subscribe, visible, () => false);
}
