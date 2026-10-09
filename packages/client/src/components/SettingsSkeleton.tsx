import { Skeleton } from "./Skeleton";

interface SettingsSkeletonField {
  title: string;
  description?: string;
  control?: "toggle" | "input" | "textarea" | "value";
}

/** Keep known labels and form geometry visible without presenting guessed values. */
export function SettingsFormSkeleton({
  label,
  fields,
  actions = false,
}: {
  label: string;
  fields: SettingsSkeletonField[];
  actions?: boolean;
}) {
  return (
    <div
      className="settings-group"
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      {fields.map(({ title, description, control = "value" }) => (
        <div
          key={title}
          className={`settings-item ${control === "input" || control === "textarea" ? "settings-skeleton-stacked" : ""}`}
        >
          <div className="settings-item-info">
            <strong>{title}</strong>
            {description && <p>{description}</p>}
          </div>
          <Skeleton
            width={
              control === "toggle" ? 44 : control === "value" ? "8em" : "100%"
            }
            height={
              control === "textarea"
                ? "16rem"
                : control === "toggle"
                  ? 24
                  : "2.25rem"
            }
            className="settings-skeleton-control"
          />
        </div>
      ))}
      {actions && (
        <div className="settings-item settings-skeleton-actions">
          <Skeleton width="5em" height="2.25rem" />
        </div>
      )}
    </div>
  );
}

export function SettingsListSkeleton({
  label,
  rows = 2,
  variant = "settings",
}: {
  label: string;
  rows?: number;
  variant?: "settings" | "devices";
}) {
  return (
    <div
      className={variant === "devices" ? "device-list" : "settings-group"}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static loading placeholders
          key={index}
          className={
            variant === "devices" ? "device-list-item" : "settings-item"
          }
          aria-hidden="true"
        >
          <div className="settings-skeleton-lines">
            <Skeleton width="55%" />
            <Skeleton width="80%" height="0.85em" />
            <Skeleton width="65%" height="0.85em" />
          </div>
          <Skeleton
            width="5em"
            height="2.25rem"
            className="settings-skeleton-control"
          />
        </div>
      ))}
    </div>
  );
}
