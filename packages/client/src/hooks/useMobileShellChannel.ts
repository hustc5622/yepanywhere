import { useCallback, useEffect, useMemo, useState } from "react";

export type MobileShellChannel = "tcp" | "http";
export type MobileShellNode = {
  alias: string;
  label: string;
  origin: string;
};

export const MOBILE_SHELL_NODES: MobileShellNode[] = [
  {
    alias: "air",
    label: "43.226.60.75:46789",
    origin: "http://43.226.60.75:46789",
  },
  {
    alias: "mini",
    label: "39.106.189.88:18022",
    origin: "http://39.106.189.88:18022",
  },
  {
    alias: "home",
    label: "47.95.254.240:5750",
    origin: "http://47.95.254.240:5750",
  },
];

export function formatMobileShellNodeLabel(
  node: Pick<MobileShellNode, "alias" | "label">,
): string {
  return `${node.label} (${node.alias})`;
}

export function formatMobileShellNodeOrigin(origin: string | null): string {
  if (!origin) return "TCP";
  const knownNode = MOBILE_SHELL_NODES.find((node) => node.origin === origin);
  if (knownNode) return formatMobileShellNodeLabel(knownNode);
  return origin.replace(/^https?:\/\//, "");
}

const CHANNEL_STATUS_MESSAGE = "yep-anywhere:mobile-shell-channel";
const GET_CHANNEL_MESSAGE = "yep-anywhere:mobile-shell-get-channel";
const SET_CHANNEL_MESSAGE = "yep-anywhere:mobile-shell-set-channel";
const OPEN_SETTINGS_MESSAGE = "yep-anywhere:mobile-shell-open-settings";

function isMobileShellDocument(): boolean {
  if (document.documentElement.dataset.mobileShell === "true") {
    return true;
  }

  try {
    return (
      window.parent !== window && /Android|wv/i.test(window.navigator.userAgent)
    );
  } catch {
    return /Android|wv/i.test(window.navigator.userAgent);
  }
}

function isMobileShellChannel(value: unknown): value is MobileShellChannel {
  return value === "tcp" || value === "http";
}

function currentAppPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function useMobileShellChannel() {
  const isMobileShell = useMemo(isMobileShellDocument, []);
  const [channel, setChannelState] = useState<MobileShellChannel>("tcp");
  const [nodeOrigin, setNodeOriginState] = useState<string | null>(null);

  useEffect(() => {
    if (!isMobileShell || window.parent === window) return;

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown;
        channel?: unknown;
        origin?: unknown;
      } | null;
      if (!data || data.type !== CHANNEL_STATUS_MESSAGE) return;
      if (isMobileShellChannel(data.channel)) {
        setChannelState(data.channel);
      }
      setNodeOriginState(typeof data.origin === "string" ? data.origin : null);
    };

    window.addEventListener("message", handleMessage);
    window.parent.postMessage({ type: GET_CHANNEL_MESSAGE }, "*");

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [isMobileShell]);

  const setChannel = useCallback(
    (nextChannel: MobileShellChannel) => {
      setChannelState(nextChannel);
      if (nextChannel === "http") {
        setNodeOriginState(null);
      }
      if (!isMobileShell || window.parent === window) return;
      window.parent.postMessage(
        {
          type: SET_CHANNEL_MESSAGE,
          channel: nextChannel,
          path: currentAppPath(),
        },
        "*",
      );
    },
    [isMobileShell],
  );

  const setNode = useCallback(
    (nextNode: MobileShellNode) => {
      setChannelState("tcp");
      setNodeOriginState(nextNode.origin);
      if (!isMobileShell || window.parent === window) return;
      window.parent.postMessage(
        {
          type: SET_CHANNEL_MESSAGE,
          channel: "tcp",
          node: nextNode.origin,
          path: currentAppPath(),
        },
        "*",
      );
    },
    [isMobileShell],
  );

  const openConnectionSettings = useCallback(() => {
    if (!isMobileShell || window.parent === window) return;
    window.parent.postMessage({ type: OPEN_SETTINGS_MESSAGE }, "*");
  }, [isMobileShell]);

  return {
    isMobileShell,
    channel,
    nodeOrigin,
    setChannel,
    setNode,
    openConnectionSettings,
  };
}
