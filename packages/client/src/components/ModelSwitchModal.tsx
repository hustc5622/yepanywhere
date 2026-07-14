import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

interface ModelSwitchModalProps {
  processId: string;
  currentModel?: string;
  onModelChanged: (model: string, reasoningEffort?: string) => void;
  onClose: () => void;
}

interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

export function ModelSwitchModal({
  processId,
  currentModel,
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
              const isCurrent = currentModel
                ? currentModel.includes(model.id) ||
                  model.id.includes(currentModel)
                : false;
              return (
                <button
                  key={model.id}
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
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
