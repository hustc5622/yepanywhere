import { useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

export interface CodexSkillOption {
  name: string;
  /** Provider path used only in the structured request body. Never render it. */
  path: string;
}

interface CodexSkillPickerProps {
  sessionId: string;
  selected: CodexSkillOption | null;
  onSelect: (skill: CodexSkillOption | null) => void;
  disabled?: boolean;
}

const MAX_SKILLS = 40;
const MAX_SKILL_NAME_CHARS = 80;
const MAX_SKILL_PATH_CHARS = 4_096;
const MAX_SKILL_GROUPS = 8;

export function parseCodexSkillsList(value: unknown): CodexSkillOption[] {
  const root = recordValue(value);
  const groups = Array.isArray(root?.data)
    ? root.data.slice(0, MAX_SKILL_GROUPS)
    : [];
  const byName = new Map<string, CodexSkillOption>();

  for (const groupValue of groups) {
    const group = recordValue(groupValue);
    const skills = Array.isArray(group?.skills)
      ? group.skills.slice(0, MAX_SKILLS * 2)
      : [];
    for (const skillValue of skills) {
      const skill = recordValue(skillValue);
      if (skill?.enabled === false) continue;
      const name = safeSkillName(skill?.name);
      const path = safeSkillPath(skill?.path);
      if (!name || !path || byName.has(name)) continue;
      byName.set(name, { name, path });
      if (byName.size >= MAX_SKILLS) break;
    }
    if (byName.size >= MAX_SKILLS) break;
  }

  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function CodexSkillPicker({
  sessionId,
  selected,
  onSelect,
  disabled = false,
}: CodexSkillPickerProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [skills, setSkills] = useState<CodexSkillOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const loadSkills = async () => {
    if (loading) return;
    setLoading(true);
    setUnavailable(false);
    try {
      const result = await api.executeCodexControl(sessionId, {
        control: "skills/list",
      });
      setSkills(parseCodexSkillsList(result.data));
      setLoaded(true);
    } catch {
      // The control is optional across Codex versions and runtime states.
      // Keep the fallback generic: provider errors may contain local paths.
      setSkills([]);
      setUnavailable(true);
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  };

  const openPicker = () => {
    setIsOpen(true);
    if (!loaded && !loading) void loadSkills();
  };

  return (
    <div className="codex-skill-picker" data-testid="codex-skill-picker">
      <button
        type="button"
        className="codex-skill-picker-button"
        onClick={openPicker}
        disabled={disabled}
        aria-label={t("codexSkillsChoose")}
      >
        <span aria-hidden="true">$</span>
        <span>{t("codexSkillsButton")}</span>
      </button>
      {selected && (
        <div className="codex-skill-selection">
          <span className="codex-skill-selection-kind">Skill</span>
          <span className="codex-skill-selection-name">{selected.name}</span>
          <button
            type="button"
            className="codex-skill-selection-remove"
            onClick={() => onSelect(null)}
            aria-label={t("codexSkillsRemove", { name: selected.name })}
          >
            ×
          </button>
        </div>
      )}
      {isOpen && (
        <Modal
          title={t("codexSkillsTitle")}
          backLabel={t("actionBack")}
          onClose={() => setIsOpen(false)}
        >
          <div className="codex-skill-modal-content">
            {loading && (
              <div className="codex-skill-modal-status" role="status">
                {t("codexSkillsLoading")}
              </div>
            )}
            {!loading && unavailable && (
              <div className="codex-skill-modal-status" role="status">
                <span>{t("codexSkillsUnavailable")}</span>
                <button type="button" onClick={() => void loadSkills()}>
                  {t("statusBadgeRetryShort")}
                </button>
              </div>
            )}
            {!loading && !unavailable && loaded && skills.length === 0 && (
              <div className="codex-skill-modal-status" role="status">
                {t("codexSkillsEmpty")}
              </div>
            )}
            {!loading && skills.length > 0 && (
              <div
                className="codex-skill-list"
                role="listbox"
                tabIndex={0}
                aria-label={t("codexSkillsTitle")}
              >
                {skills.map((skill) => (
                  <button
                    key={skill.name}
                    type="button"
                    className={`codex-skill-item ${selected?.name === skill.name ? "selected" : ""}`}
                    onClick={() => {
                      onSelect(skill);
                      setIsOpen(false);
                    }}
                    role="option"
                    aria-selected={selected?.name === skill.name}
                  >
                    {skill.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function safeSkillName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (
    !name ||
    name.length > MAX_SKILL_NAME_CHARS ||
    /[\\/]/.test(name) ||
    hasControlCharacter(name)
  ) {
    return undefined;
  }
  return name;
}

function safeSkillPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (
    !path ||
    path.length > MAX_SKILL_PATH_CHARS ||
    hasControlCharacter(path)
  ) {
    return undefined;
  }
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
    ? path
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
