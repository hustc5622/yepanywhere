import type { LiveProviderName } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import { getNewSessionLayout } from "../lib/newSessionLayout";
import { Skeleton } from "./Skeleton";

export function PiGatewayKeySkeleton() {
  const { t } = useI18n();
  const counts = getNewSessionLayout().piGatewayKeyCounts ?? [1];
  if (counts.length === 0) return null;
  return (
    <div
      className="new-session-gateway-key-section"
      role="status"
      aria-label={t("newSessionOptionsLoading")}
      aria-busy="true"
    >
      <div className="new-session-gateway-key-header">
        <h3>{t("newSessionGatewayKeyTitle")}</h3>
        <div className="gateway-key-header-actions" aria-hidden="true">
          <Skeleton width="4em" />
          <Skeleton width="3em" />
        </div>
      </div>
      <p className="new-session-section-hint">
        {t("newSessionGatewayKeyHint")}
      </p>
      <div className="gateway-key-list" aria-hidden="true">
        {counts.map((count, groupIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed layout placeholders
          <div className="gateway-key-group" key={groupIndex}>
            {counts.length > 1 && (
              <div className="gateway-key-group-header">
                <Skeleton width="8em" />
              </div>
            )}
            {count === 0 ? (
              <p className="gateway-key-empty">
                <Skeleton width="7em" />
              </p>
            ) : (
              Array.from({ length: count }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed layout placeholders
                <div className="gateway-key-row" key={index}>
                  <div className="gateway-key-option new-session-key-skeleton">
                    <Skeleton width={10} height={10} radius="50%" />
                    <span className="gateway-key-body">
                      <span className="gateway-key-title">
                        <Skeleton width="60%" />
                      </span>
                      <span className="gateway-key-meta">
                        <Skeleton width="40%" />
                      </span>
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Match account rows before their names and live usage are available. */
export function NewSessionAccountSkeleton({
  provider,
}: {
  provider?: LiveProviderName;
}) {
  const { t } = useI18n();
  const count = getNewSessionLayout().codexAccountCount ?? 2;
  // The real picker is omitted for a single machine account as well.
  if (count <= 1) return null;
  return (
    <div
      className="new-session-codex-account-section"
      role="status"
      aria-label={t("newSessionOptionsLoading")}
      aria-busy="true"
    >
      <h3>
        {provider === "codex" ? (
          t("newSessionCodexAccountTitle")
        ) : (
          <Skeleton width="9em" />
        )}
      </h3>
      <p className="new-session-section-hint">
        {provider === "codex" ? (
          t("newSessionCodexAccountDescription")
        ) : (
          <Skeleton width="85%" />
        )}
      </p>
      <div className="codex-mcp-options" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <div
            className="mode-option new-session-account-skeleton"
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
            key={`account-${index}`}
          >
            <Skeleton width={12} height={12} radius="50%" />
            <div className="mode-option-content">
              <span className="mode-option-label">
                <Skeleton width="65%" />
              </span>
              <span className="mode-option-desc">
                <Skeleton width="45%" />
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Keep the above-composer structure present while defaults are loading. */
export function NewSessionSetupSkeleton({
  provider = getNewSessionLayout().provider,
}: {
  provider?: LiveProviderName;
}) {
  const { t } = useI18n();
  if (provider === "pi") return <PiGatewayKeySkeleton />;
  if (provider && provider !== "codex") return null;
  return (
    <>
      <NewSessionAccountSkeleton provider={provider} />
      <div
        className="codex-usage-card codex-usage-card-collapsible"
        aria-hidden="true"
      >
        <div className="codex-usage-disclosure new-session-usage-skeleton">
          {provider === "codex" ? (
            t("newSessionCodexUsageTitle")
          ) : (
            <Skeleton width="12em" />
          )}
          <Skeleton width="3em" />
        </div>
      </div>
    </>
  );
}

/** The project-loading state uses the same vertical form layout. */
export function NewSessionFormSkeleton() {
  const { t } = useI18n();
  return (
    <div
      className="new-session-form new-session-container"
      role="status"
      aria-label={t("newSessionOptionsLoading")}
      aria-busy="true"
    >
      <div className="new-session-header">
        <h1>{t("newSessionHeaderTitle")}</h1>
        <p className="new-session-subtitle">{t("newSessionHeaderSubtitle")}</p>
      </div>
      <NewSessionSetupSkeleton />
      <div className="new-session-input-area" aria-hidden="true">
        <Skeleton height="10rem" />
        <Skeleton width="8rem" height="2.5rem" />
      </div>
    </div>
  );
}
