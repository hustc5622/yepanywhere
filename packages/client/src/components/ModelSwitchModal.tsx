import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

interface ModelSwitchModalProps {
  processId: string;
  currentModel?: string;
  currentReasoningEffort?: string;
  onModelChanged: (model: string, reasoningEffort?: string) => void;
  onClose: () => void;
}

interface ModelOption {
  id: string;
  name: string;
  description?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort?: string;
}

function modelIdsMatch(currentModel: string | undefined, modelId: string) {
  if (!currentModel) return false;
  return (
    currentModel === modelId ||
    currentModel.endsWith(`/${modelId}`) ||
    modelId.endsWith(`/${currentModel}`)
  );
}

export function ModelSwitchModal({
  processId,
  currentModel,
  currentReasoningEffort,
  onModelChanged,
  onClose,
}: ModelSwitchModalProps) {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    api
      .getProcessModels(processId)
      .then((res) => setModels(res.models))
      .catch((err) => setError(err.message || t("modelSwitchLoadFailed")))
      .finally(() => setLoading(false));
  }, [processId, t]);

  const handleSelect = async (modelId: string) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      const result = await api.setProcessModel(processId, modelId);
      onModelChanged(modelId, result.reasoningEffort);
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : t("modelSwitchChangeFailed"),
      );
      setSwitching(false);
    }
  };

  /**
   * Switch the reasoning/thought level. Switches the model first when the
   * target model differs from the current one; a pure level change only
   * calls the reasoning-effort endpoint (ZCode session/setThoughtLevel).
   */
  const handleSelectEffort = async (modelId: string, effort: string) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      const isCurrentModel = modelIdsMatch(currentModel, modelId);
      if (!isCurrentModel) {
        await api.setProcessModel(processId, modelId);
      }
      await api.setProcessReasoningEffort(processId, effort);
      onModelChanged(modelId, effort);
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : t("modelSwitchChangeFailed"),
      );
      setSwitching(false);
    }
  };

  return (
    <Modal title={t("modelSwitchTitle")} onClose={onClose}>
      <div className="model-switch-content">
        {loading && (
          <div className="model-switch-loading">{t("modelSwitchLoading")}</div>
        )}
        {error && <div className="model-switch-error">{error}</div>}
        {!loading && !error && models.length === 0 && (
          <div className="model-switch-loading">{t("modelSwitchEmpty")}</div>
        )}
        {!loading && models.length > 0 && (
          <div className="model-switch-list">
            {models.map((model) => {
              const isCurrent = modelIdsMatch(currentModel, model.id);
              const efforts = model.supportedReasoningEfforts ?? [];
              return (
                <div key={model.id} className="model-switch-entry">
                  <button
                    type="button"
                    className={`model-switch-item ${isCurrent ? "current" : ""}`}
                    onClick={() => handleSelect(model.id)}
                    disabled={switching}
                  >
                    <span className="model-switch-name">{model.name}</span>
                    {model.description && (
                      <span className="model-switch-description">
                        {model.description}
                      </span>
                    )}
                    {isCurrent && (
                      <span className="model-switch-badge">
                        {t("modelSwitchCurrent")}
                      </span>
                    )}
                  </button>
                  {efforts.length > 0 && (
                    <div className="model-switch-efforts">
                      {efforts.map(({ reasoningEffort }) => {
                        const isCurrentEffort =
                          isCurrent &&
                          reasoningEffort === currentReasoningEffort;
                        return (
                          <button
                            key={reasoningEffort}
                            type="button"
                            className={`model-switch-effort ${isCurrentEffort ? "current" : ""}`}
                            onClick={() =>
                              handleSelectEffort(model.id, reasoningEffort)
                            }
                            disabled={switching}
                          >
                            {reasoningEffort}
                            {isCurrentEffort && (
                              <span className="model-switch-badge">
                                {t("modelSwitchCurrent")}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
