import { useProviders } from "../../hooks/useProviders";
import { useI18n } from "../../i18n";
import { getAllProviders } from "../../providers/registry";

export function ProvidersSettings() {
  const { t } = useI18n();
  const { providers: serverProviders, loading: providersLoading } =
    useProviders();

  // Merge server detection status with client-side metadata
  const registeredProviders = getAllProviders();
  const providerDisplayList = registeredProviders.map((clientProvider) => {
    const serverInfo = serverProviders.find(
      (p) => p.name === clientProvider.id,
    );
    return {
      ...clientProvider,
      installed: serverInfo?.installed ?? false,
      authenticated: serverInfo?.authenticated ?? false,
    };
  });

  return (
    <section className="settings-section">
      <h2>{t("providersSectionTitle")}</h2>
      <p className="settings-section-description">
        {t("providersSectionDescription")}
      </p>
      <div className="settings-group">
        {providerDisplayList.map((provider) => (
          <div key={provider.id} className="settings-item">
            <div className="settings-item-info">
              <div className="settings-item-header">
                <strong>{provider.displayName}</strong>
                {provider.installed ? (
                  <span className="settings-status-badge settings-status-detected">
                    {t("providersDetected")}
                  </span>
                ) : (
                  <span className="settings-status-badge settings-status-not-detected">
                    {t("providersNotDetected")}
                  </span>
                )}
              </div>
              <p>{provider.metadata.description}</p>
              {provider.metadata.limitations.length > 0 && (
                <ul className="settings-limitations">
                  {provider.metadata.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              )}
            </div>
            {provider.metadata.website && (
              <a
                href={provider.metadata.website}
                target="_blank"
                rel="noopener noreferrer"
                className="settings-link"
              >
                {t("providersWebsite")}
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
