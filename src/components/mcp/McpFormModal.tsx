import React, { useMemo, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Save,
  Plus,
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import JsonEditor from "@/components/JsonEditor";
import type { AppId } from "@/lib/api/types";
import { McpApps, McpServer, McpServerSpec } from "@/types";
import { MCP_APP_IDS } from "@/config/appConfig";
import { mcpPresets, getMcpPresetWithDescription } from "@/config/mcpPresets";
import McpWizardModal from "./McpWizardModal";
import {
  extractErrorMessage,
  translateMcpBackendError,
} from "@/utils/errorUtils";
import {
  tomlToMcpServer,
  extractIdFromToml,
  mcpServerToToml,
} from "@/utils/tomlUtils";
import { normalizeTomlText } from "@/utils/textNormalization";
import { parseSmartMcpJson } from "@/utils/formatters";
import { useMcpValidation } from "./useMcpValidation";
import { useUpsertMcpServer } from "@/hooks/useMcp";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import "./McpFormModal.css";

interface McpFormModalProps {
  editingId?: string;
  initialData?: McpServer;
  onSave: () => Promise<void>;
  onClose: () => void;
  existingIds?: string[];
  defaultFormat?: "json" | "toml";
  defaultEnabledApps?: AppId[];
  visibleApps?: AppId[];
}

const McpFormModal: React.FC<McpFormModalProps> = ({
  editingId,
  initialData,
  onSave,
  onClose,
  existingIds = [],
  defaultFormat = "json",
  visibleApps,
  defaultEnabledApps = ["claude", "codex", "gemini", "grokbuild"],
}) => {
  const { t } = useTranslation();
  const fieldPrefix = React.useId();
  const { formatTomlError, validateTomlConfig, validateJsonConfig } =
    useMcpValidation();

  const upsertMutation = useUpsertMcpServer();

  const [formId, setFormId] = useState(
    () => editingId || initialData?.id || "",
  );
  const [formName, setFormName] = useState(initialData?.name || "");
  const [formDescription, setFormDescription] = useState(
    initialData?.description || "",
  );
  const [formHomepage, setFormHomepage] = useState(initialData?.homepage || "");
  const [formDocs, setFormDocs] = useState(initialData?.docs || "");
  const [formTags, setFormTags] = useState(initialData?.tags?.join(", ") || "");

  type McpAppKey = keyof McpApps;
  const selectableApps = useMemo<McpAppKey[]>(
    () =>
      (visibleApps ?? MCP_APP_IDS).filter(
        (id): id is McpAppKey => id !== "claude-desktop" && id !== "openclaw",
      ),
    [visibleApps],
  );

  const [enabledApps, setEnabledApps] = useState<McpApps>(() => {
    const initial: McpApps = {
      claude: false,
      codex: false,
      gemini: false,
      grokbuild: false,
      opencode: false,
      hermes: false,
      pi: false,
      omp: false,
      agy: false,
      mcode: false,
      kimi: false,
      dsh: false,
      copilot: false,
      workbuddy: false,
      codebuddy: false,
    };
    if (initialData?.apps) {
      return { ...initial, ...initialData.apps };
    }
    for (const appId of defaultEnabledApps) {
      if (appId !== "claude-desktop" && appId !== "openclaw") {
        initial[appId as McpAppKey] = true;
      }
    }
    return initial;
  });

  const isEditing = !!editingId;

  const hasAdditionalInfo = !!(
    initialData?.description ||
    initialData?.tags?.length ||
    initialData?.homepage ||
    initialData?.docs
  );

  const [showMetadata, setShowMetadata] = useState(
    isEditing ? hasAdditionalInfo : false,
  );

  const useTomlFormat = useMemo(() => {
    if (initialData?.server) {
      return defaultFormat === "toml";
    }
    return defaultFormat === "toml";
  }, [defaultFormat, initialData]);

  const [formConfig, setFormConfig] = useState(() => {
    const spec = initialData?.server;
    if (!spec) return "";
    if (useTomlFormat) {
      return mcpServerToToml(spec);
    }
    return JSON.stringify(spec, null, 2);
  });

  const [configError, setConfigError] = useState("");
  const [saving, setSaving] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [idError, setIdError] = useState("");
  const [isDarkMode, setIsDarkMode] = useState(false);

  useEffect(() => {
    setIsDarkMode(document.documentElement.classList.contains("dark"));

    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains("dark"));
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  const useToml = useTomlFormat;

  const wizardInitialSpec = useMemo(() => {
    const fallback = initialData?.server;
    if (!formConfig.trim()) {
      return fallback;
    }

    if (useToml) {
      try {
        return tomlToMcpServer(formConfig);
      } catch {
        return fallback;
      }
    }

    try {
      const parsed = JSON.parse(formConfig);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as McpServerSpec;
      }
      return fallback;
    } catch {
      return fallback;
    }
  }, [formConfig, initialData, useToml]);

  const [selectedPreset, setSelectedPreset] = useState<number | null>(
    isEditing ? null : -1,
  );

  const handleIdChange = (value: string) => {
    setFormId(value);
    if (!isEditing) {
      const exists = existingIds.includes(value.trim());
      setIdError(exists ? t("mcp.error.idExists") : "");
    }
  };

  const ensureUniqueId = (base: string): string => {
    let candidate = base.trim();
    if (!candidate) candidate = "mcp-server";
    if (!existingIds.includes(candidate)) return candidate;
    let i = 1;
    while (existingIds.includes(`${candidate}-${i}`)) i++;
    return `${candidate}-${i}`;
  };

  const applyPreset = (index: number) => {
    if (index < 0 || index >= mcpPresets.length) return;
    const preset = mcpPresets[index];
    const presetWithDesc = getMcpPresetWithDescription(preset, t);

    const id = ensureUniqueId(presetWithDesc.id);
    setFormId(id);
    setFormName(presetWithDesc.name || presetWithDesc.id);
    setFormDescription(presetWithDesc.description || "");
    setFormHomepage(presetWithDesc.homepage || "");
    setFormDocs(presetWithDesc.docs || "");
    setFormTags(presetWithDesc.tags?.join(", ") || "");

    if (useToml) {
      const toml = mcpServerToToml(presetWithDesc.server);
      setFormConfig(toml);
      setConfigError(validateTomlConfig(toml));
    } else {
      const json = JSON.stringify(presetWithDesc.server, null, 2);
      setFormConfig(json);
      setConfigError(validateJsonConfig(json));
    }
    setSelectedPreset(index);
  };

  const applyCustom = () => {
    setSelectedPreset(-1);
    setFormId("");
    setFormName("");
    setFormDescription("");
    setFormHomepage("");
    setFormDocs("");
    setFormTags("");
    setFormConfig("");
    setConfigError("");
  };

  const handleConfigChange = (value: string) => {
    const nextValue = useToml ? normalizeTomlText(value) : value;
    setFormConfig(nextValue);

    if (useToml) {
      const err = validateTomlConfig(nextValue);
      if (err) {
        setConfigError(err);
        return;
      }

      if (nextValue.trim() && !formId.trim()) {
        const extractedId = extractIdFromToml(nextValue);
        if (extractedId) {
          setFormId(extractedId);
        }
      }
    } else {
      try {
        const result = parseSmartMcpJson(value);
        const configJson = JSON.stringify(result.config);
        const validationErr = validateJsonConfig(configJson);

        if (validationErr) {
          setConfigError(validationErr);
          return;
        }

        if (result.id && !formId.trim() && !isEditing) {
          const uniqueId = ensureUniqueId(result.id);
          setFormId(uniqueId);

          if (!formName.trim()) {
            setFormName(result.id);
          }
        }

        setConfigError("");
      } catch (err: any) {
        const errorMessage = err?.message || String(err);
        setConfigError(t("mcp.error.jsonInvalid") + ": " + errorMessage);
      }
    }
  };

  const handleWizardApply = (title: string, json: string) => {
    setFormId(title);
    if (!formName.trim()) {
      setFormName(title);
    }
    if (useToml) {
      try {
        const server = JSON.parse(json) as McpServerSpec;
        const toml = mcpServerToToml(server);
        setFormConfig(toml);
        setConfigError(validateTomlConfig(toml));
      } catch (e: any) {
        setConfigError(t("mcp.error.jsonInvalid"));
      }
    } else {
      setFormConfig(json);
      setConfigError(validateJsonConfig(json));
    }
  };

  const handleSubmit = async () => {
    const trimmedId = formId.trim();
    if (!trimmedId) {
      toast.error(t("mcp.error.idRequired"), { duration: 3000 });
      return;
    }

    if (!isEditing && existingIds.includes(trimmedId)) {
      setIdError(t("mcp.error.idExists"));
      return;
    }

    let serverSpec: McpServerSpec;

    if (useToml) {
      const tomlError = validateTomlConfig(formConfig);
      setConfigError(tomlError);
      if (tomlError) {
        toast.error(t("mcp.error.tomlInvalid"), { duration: 3000 });
        return;
      }

      if (!formConfig.trim()) {
        serverSpec = {
          type: "stdio",
          command: "",
          args: [],
        };
      } else {
        try {
          serverSpec = tomlToMcpServer(formConfig);
        } catch (e: any) {
          const msg = e?.message || String(e);
          setConfigError(formatTomlError(msg));
          toast.error(t("mcp.error.tomlInvalid"), { duration: 4000 });
          return;
        }
      }
    } else {
      if (!formConfig.trim()) {
        serverSpec = {
          type: "stdio",
          command: "",
          args: [],
        };
      } else {
        try {
          const result = parseSmartMcpJson(formConfig);
          serverSpec = result.config as McpServerSpec;
        } catch (e: any) {
          const errorMessage = e?.message || String(e);
          setConfigError(t("mcp.error.jsonInvalid") + ": " + errorMessage);
          toast.error(t("mcp.error.jsonInvalid"), { duration: 4000 });
          return;
        }
      }
    }

    if (serverSpec?.type === "stdio" && !serverSpec?.command?.trim()) {
      toast.error(t("mcp.error.commandRequired"), { duration: 3000 });
      return;
    }
    if (
      (serverSpec?.type === "http" || serverSpec?.type === "sse") &&
      !serverSpec?.url?.trim()
    ) {
      toast.error(t("mcp.wizard.urlRequired"), { duration: 3000 });
      return;
    }

    setSaving(true);
    try {
      const nameTrimmed = (formName || trimmedId).trim();
      const finalName = nameTrimmed || trimmedId;

      const entry: McpServer = {
        ...(initialData ? { ...initialData } : {}),
        id: trimmedId,
        name: finalName,
        server: serverSpec,
        apps: enabledApps,
      };

      const descriptionTrimmed = formDescription.trim();
      if (descriptionTrimmed) {
        entry.description = descriptionTrimmed;
      } else {
        delete entry.description;
      }

      const homepageTrimmed = formHomepage.trim();
      if (homepageTrimmed) {
        entry.homepage = homepageTrimmed;
      } else {
        delete entry.homepage;
      }

      const docsTrimmed = formDocs.trim();
      if (docsTrimmed) {
        entry.docs = docsTrimmed;
      } else {
        delete entry.docs;
      }

      const parsedTags = formTags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      if (parsedTags.length > 0) {
        entry.tags = parsedTags;
      } else {
        delete entry.tags;
      }

      await upsertMutation.mutateAsync(entry);
      toast.success(t("common.success"), { closeButton: true });
      await onSave();
    } catch (error: any) {
      const detail = extractErrorMessage(error);
      const mapped = translateMcpBackendError(detail, t);
      const msg = mapped || detail || t("mcp.error.saveFailed");
      toast.error(msg, { duration: mapped || detail ? 6000 : 4000 });
    } finally {
      setSaving(false);
    }
  };

  const getFormTitle = () => {
    return isEditing ? t("mcp.editServer") : t("mcp.addServer");
  };

  return (
    <>
      <FullScreenPanel
        isOpen={true}
        title={getFormTitle()}
        onClose={onClose}
        editorHeader={
          <>
            <button
              type="button"
              className="secondary editor-back"
              aria-label={t("common.back", { defaultValue: "返回" })}
              onClick={onClose}
              disabled={saving}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              {t("common.back", { defaultValue: "返回" })}
            </button>
            <div className="editor-heading">
              <h2>{getFormTitle()}</h2>
              <span>{useToml ? "TOML · MCP" : "JSON · MCP"}</span>
            </div>
          </>
        }
        footer={
          <div className="mcp-form-footer-actions">
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={saving}
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={saving || (!isEditing && !!idError)}
              className="primary inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEditing ? <Save size={15} /> : <Plus size={15} />}
              {saving
                ? t("common.saving")
                : isEditing
                  ? t("common.save")
                  : t("common.add")}
            </Button>
          </div>
        }
      >
        <div className="editor-form mcp-form-stage">
          {/* 上半部分：基础信息与启用范围 */}
          <section className="mcp-form-section">
            {/* 预设选择（仅新增时展示） */}
            {!isEditing && (
              <div className="mcp-form-field">
                <span className="mcp-form-section-title">
                  {t("mcp.presets.title")}
                </span>
                <div className="mcp-preset-row">
                  <button
                    type="button"
                    onClick={applyCustom}
                    className={`mcp-preset-pill ${
                      selectedPreset === -1 ? "is-active" : ""
                    }`}
                  >
                    {t("presetSelector.custom")}
                  </button>
                  {mcpPresets.map((preset, idx) => {
                    const descriptionKey = `mcp.presets.${preset.id}.description`;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPreset(idx)}
                        className={`mcp-preset-pill ${
                          selectedPreset === idx ? "is-active" : ""
                        }`}
                        title={t(descriptionKey)}
                      >
                        {preset.id}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ID (标题) + Name */}
            <div className="mcp-form-grid">
              <div className="mcp-form-field">
                <div className="mcp-form-field-head">
                  <label
                    htmlFor={`${fieldPrefix}-title`}
                    className="mcp-form-label"
                  >
                    {t("mcp.form.title")}{" "}
                    <span className="mcp-form-required">*</span>
                  </label>
                  {!isEditing && idError && (
                    <span className="mcp-form-error-inline">{idError}</span>
                  )}
                </div>
                <Input
                  id={`${fieldPrefix}-title`}
                  type="text"
                  placeholder={t("mcp.form.titlePlaceholder")}
                  value={formId}
                  onChange={(e) => handleIdChange(e.target.value)}
                  disabled={isEditing}
                />
              </div>

              <div className="mcp-form-field">
                <label
                  htmlFor={`${fieldPrefix}-name`}
                  className="mcp-form-label"
                >
                  {t("mcp.form.name")}
                </label>
                <Input
                  id={`${fieldPrefix}-name`}
                  type="text"
                  placeholder={t("mcp.form.namePlaceholder")}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                />
              </div>
            </div>

            {/* 启用到哪些应用 */}
            <div className="mcp-form-field">
              <span className="mcp-form-label">
                {t("mcp.form.enabledApps")}
              </span>
              <div className="mcp-apps-grid">
                {selectableApps.map((appId) => {
                  const checked = Boolean(enabledApps[appId]);
                  return (
                    <div
                      key={appId}
                      className={`mcp-app-chip ${checked ? "is-checked" : ""}`}
                    >
                      <Checkbox
                        id={`enable-${appId}`}
                        checked={checked}
                        onCheckedChange={(next: boolean) =>
                          setEnabledApps((prev) => ({
                            ...prev,
                            [appId]: next,
                          }))
                        }
                      />
                      <label htmlFor={`enable-${appId}`}>
                        {t(`mcp.unifiedPanel.apps.${appId}`)}
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 可折叠的附加信息按钮 */}
            <div>
              <button
                type="button"
                onClick={() => setShowMetadata(!showMetadata)}
                aria-expanded={showMetadata}
                className="mcp-meta-toggle"
              >
                {showMetadata ? (
                  <ChevronUp size={15} aria-hidden="true" />
                ) : (
                  <ChevronDown size={15} aria-hidden="true" />
                )}
                {t("mcp.form.additionalInfo")}
              </button>
            </div>

            {/* 附加信息区域（可折叠） */}
            {showMetadata && (
              <div className="mcp-form-grid">
                <div className="mcp-form-field">
                  <label
                    htmlFor={`${fieldPrefix}-description`}
                    className="mcp-form-label"
                  >
                    {t("mcp.form.description")}
                  </label>
                  <Input
                    id={`${fieldPrefix}-description`}
                    type="text"
                    placeholder={t("mcp.form.descriptionPlaceholder")}
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                  />
                </div>

                <div className="mcp-form-field">
                  <label
                    htmlFor={`${fieldPrefix}-tags`}
                    className="mcp-form-label"
                  >
                    {t("mcp.form.tags")}
                  </label>
                  <Input
                    id={`${fieldPrefix}-tags`}
                    type="text"
                    placeholder={t("mcp.form.tagsPlaceholder")}
                    value={formTags}
                    onChange={(e) => setFormTags(e.target.value)}
                  />
                </div>

                <div className="mcp-form-field">
                  <label
                    htmlFor={`${fieldPrefix}-homepage`}
                    className="mcp-form-label"
                  >
                    {t("mcp.form.homepage")}
                  </label>
                  <Input
                    id={`${fieldPrefix}-homepage`}
                    type="text"
                    placeholder={t("mcp.form.homepagePlaceholder")}
                    value={formHomepage}
                    onChange={(e) => setFormHomepage(e.target.value)}
                  />
                </div>

                <div className="mcp-form-field">
                  <label
                    htmlFor={`${fieldPrefix}-docs`}
                    className="mcp-form-label"
                  >
                    {t("mcp.form.docs")}
                  </label>
                  <Input
                    id={`${fieldPrefix}-docs`}
                    type="text"
                    placeholder={t("mcp.form.docsPlaceholder")}
                    value={formDocs}
                    onChange={(e) => setFormDocs(e.target.value)}
                  />
                </div>
              </div>
            )}
          </section>

          {/* 下半部分：JSON / TOML 配置编辑器 */}
          <section className="mcp-form-section">
            <div className="mcp-form-section-head">
              <span className="mcp-form-section-title">
                {useToml ? t("mcp.form.tomlConfig") : t("mcp.form.jsonConfig")}
              </span>
              {(isEditing || selectedPreset === -1) && (
                <button
                  type="button"
                  onClick={() => setIsWizardOpen(true)}
                  className="mcp-wizard-btn"
                >
                  <Wand2 size={13} aria-hidden="true" />
                  {t("mcp.form.useWizard")}
                </button>
              )}
            </div>
            <div className="mcp-editor-frame">
              <JsonEditor
                value={formConfig}
                onChange={handleConfigChange}
                placeholder={
                  useToml
                    ? t("mcp.form.tomlPlaceholder")
                    : t("mcp.form.jsonPlaceholder")
                }
                darkMode={isDarkMode}
                rows={12}
                showValidation={!useToml}
                language={useToml ? "javascript" : "json"}
                height="260px"
              />
            </div>
            {configError && (
              <div className="mcp-config-error" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <span>{configError}</span>
              </div>
            )}
          </section>
        </div>
      </FullScreenPanel>

      {/* Wizard Modal */}
      <McpWizardModal
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onApply={handleWizardApply}
        initialTitle={formId}
        initialServer={wizardInitialSpec}
      />
    </>
  );
};

export default McpFormModal;
