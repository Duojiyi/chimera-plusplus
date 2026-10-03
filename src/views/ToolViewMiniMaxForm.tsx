import { useState } from "react";
import JsonEditor from "@/components/JsonEditor";
import { Button } from "@/components/ui/button";
import type { Provider } from "@/types";
import type { ProviderFormValues } from "@/components/providers/forms/ProviderForm";

export default function ToolViewMiniMaxForm({
  provider,
  onSubmit,
  onCancel,
  onSubmittingChange,
}: {
  provider: Provider | null;
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
  onSubmittingChange: (busy: boolean) => void;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [key, setKey] = useState(provider?.id ?? "");
  const [config, setConfig] = useState(
    JSON.stringify(
      provider?.settingsConfig ?? {
        kind: "custom",
        api: "anthropic-messages",
        options: { baseURL: "", apiKey: "" },
        models: {},
      },
      null,
      2,
    ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          const parsed = JSON.parse(config);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            (parsed.kind !== undefined && parsed.kind !== "custom")
          )
            throw new Error("仅支持 custom_provider 的自定义条目对象");
          if (
            !parsed.options?.baseURL ||
            !parsed.options?.apiKey ||
            !parsed.models ||
            Array.isArray(parsed.models) ||
            typeof parsed.models !== "object" ||
            !Object.keys(parsed.models).length
          )
            throw new Error(
              "请填写 options.baseURL、options.apiKey 及 models 模型字典",
            );
          setBusy(true);
          onSubmittingChange(true);
          await onSubmit({
            name: name.trim(),
            providerKey: key.trim(),
            settingsConfig: config,
            websiteUrl: provider?.websiteUrl ?? "",
            notes: provider?.notes ?? "",
            icon: provider?.icon ?? "",
            iconColor: provider?.iconColor ?? "",
          });
        } catch (cause) {
          setError(String(cause));
        } finally {
          setBusy(false);
          onSubmittingChange(false);
        }
      }}
    >
      <p>
        只编辑 custom_provider 的单个条目（JSON，后端写入
        YAML）。默认模型与轻量模型请在 MiniMax Code 中选择；不修改 defaultModel
        / defaultLightModel。
      </p>
      <label className="block">
        名称{" "}
        <input
          aria-label="名称"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block">
        Provider Key{" "}
        <input
          aria-label="Provider Key"
          required
          pattern="[A-Za-z0-9_-]+"
          disabled={Boolean(provider)}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <JsonEditor value={config} onChange={setConfig} />
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy}>
        保存线路
      </Button>
      <Button type="button" disabled={busy} onClick={onCancel}>
        取消
      </Button>
    </form>
  );
}
