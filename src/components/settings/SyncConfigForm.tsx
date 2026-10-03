import { Input } from "@/components/ui/input";
import type { Settings } from "@/types";

// The legacy section couples its form to autoSync and save-and-test handlers.
// Reuse its inputs/API contract, but keep this form strictly local and manual.
export function SyncConfigForm({
  backend,
  settings,
  busy,
  onSave,
  onCancel,
}: {
  backend: "webdav" | "s3";
  settings: Settings | null;
  busy: boolean;
  onSave: (values: Record<string, string>, secretTouched: boolean) => void;
  onCancel: () => void;
}) {
  const webdav = settings?.webdavSync;
  const s3 = settings?.s3Sync;
  const config = backend === "webdav" ? webdav : s3;
  const label = backend === "webdav" ? "WebDAV" : "S3";
  const secret = backend === "webdav" ? "password" : "secretAccessKey";
  const fields =
    backend === "webdav"
      ? [
          {
            name: "baseUrl",
            label: "服务器 URL",
            value: webdav?.baseUrl,
            required: true,
          },
          {
            name: "username",
            label: "用户名",
            value: webdav?.username,
            required: true,
          },
        ]
      : [
          {
            name: "endpoint",
            label: "Endpoint（AWS 可留空）",
            value: s3?.endpoint,
            required: false,
          },
          {
            name: "region",
            label: "Region",
            value: s3?.region,
            required: true,
          },
          {
            name: "bucket",
            label: "Bucket",
            value: s3?.bucket,
            required: true,
          },
          {
            name: "accessKeyId",
            label: "Access Key ID",
            value: s3?.accessKeyId,
            required: true,
          },
        ];
  fields.push(
    {
      name: "remoteRoot",
      label: "远端目录",
      value: config?.remoteRoot ?? "cc-switch-sync",
      required: true,
    },
    {
      name: "profile",
      label: "配置标识",
      value: config?.profile ?? "default",
      required: true,
    },
  );
  return (
    <form
      aria-label={`${label} 同步配置`}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const form = event.currentTarget;
        const data = new FormData(form);
        const values = Object.fromEntries(
          fields.map(({ name }) => [name, String(data.get(name) ?? "").trim()]),
        );
        values[secret] = String(data.get(secret) ?? "");
        // Do not retain entered secrets in the DOM after submission, even on failure.
        (form.elements.namedItem(secret) as HTMLInputElement).value = "";
        onSave(values, values[secret].length > 0);
      }}
    >
      <fieldset disabled={busy}>
        <legend>{label} 同步配置</legend>
        <p>保存仅写入本地配置并重新读取状态，不测试连接。自动同步固定关闭。</p>
        {fields.map(({ name, label: title, value, required }) => (
          <label key={name}>
            {label} {title}
            <Input
              name={name}
              defaultValue={value ?? ""}
              required={required}
              autoComplete="off"
            />
          </label>
        ))}
        <label>
          {label} {backend === "webdav" ? "密码" : "Secret Access Key"}
          <Input
            name={secret}
            type="password"
            defaultValue=""
            autoComplete="new-password"
            required={!config}
          />
        </label>
        <p>
          已保存的密码不会回显。已有配置留空表示保留原凭据；更换服务器或身份时请填写新凭据。
        </p>
        <button className="secondary" type="submit" disabled={busy}>
          保存 {label} 配置
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          取消配置
        </button>
      </fieldset>
    </form>
  );
}
