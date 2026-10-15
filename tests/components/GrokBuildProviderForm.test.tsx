import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import {
  GrokBuildProviderForm,
  grokApiBackendFromApiFormat,
} from "@/components/providers/forms/GrokBuildProviderForm";

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="raw-config"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

describe("GrokBuildProviderForm", () => {
  it("only offers Chimera and prefills its address", async () => {
    const { container } = render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    // 国产官方直连（cn_official）不在 Grok Build 预设列表里
    expect(screen.queryByRole("button", { name: /BytePlus/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Kimi/ })).toBeNull();

    expect(screen.queryByRole("button", { name: /PatewayAI/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Grok Official/ })).toBeNull();
    expect(screen.getByRole("button", { name: "ChimeraHub" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      container.querySelector<HTMLInputElement>("#codexBaseUrl")?.value,
    ).toBe("https://api.chimerahub.org/v1");
    expect(
      container.querySelector<HTMLInputElement>('input[name="name"]')?.value,
    ).toBe("ChimeraHub");
    expect(
      (screen.getByLabelText("raw-config") as HTMLTextAreaElement).value,
    ).toContain("gpt-5.6-sol");
    const configBefore = (
      screen.getByLabelText("raw-config") as HTMLTextAreaElement
    ).value;
    fireEvent.click(screen.getByRole("button", { name: "ChimeraHub" }));
    expect(screen.getByLabelText("raw-config")).toHaveValue(configBefore);
  });

  it("submits Chimera defaults under the native Grok profile", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    const nameInput =
      container.querySelector<HTMLInputElement>('input[name="name"]');
    const baseUrlInput =
      container.querySelector<HTMLInputElement>("#codexBaseUrl");
    expect(nameInput).not.toBeNull();
    expect(baseUrlInput).not.toBeNull();

    fireEvent.change(nameInput!, { target: { value: "Example Relay" } });
    fireEvent.change(baseUrlInput!, {
      target: { value: "https://relay.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "secret-key" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.icon).toBe("");
    const settings = JSON.parse(submitted.settingsConfig);
    const config = parseToml(settings.config) as any;

    expect(config.models.default).toBe("grok-4.5");
    expect(submitted.meta.apiFormat).toBe("openai_responses");
    expect(config.model["grok-4.5"]).toEqual({
      model: "gpt-5.6-sol",
      base_url: "https://relay.example.com/v1",
      name: "Example Relay",
      api_key: "secret-key",
      api_backend: "responses",
      context_window: 500000,
    });
  });

  it("maps API formats into Grok api_backend for a custom route", async () => {
    // 预设列表已不含 Chat Completions 条目（国产官方直连被移除），
    // chat/messages 映射分支由纯函数覆盖
    expect(grokApiBackendFromApiFormat("openai_chat")).toBe("chat_completions");
    expect(grokApiBackendFromApiFormat("anthropic")).toBe("messages");
    expect(grokApiBackendFromApiFormat("openai_responses")).toBe("responses");

    // 组件级接线用带显式 apiFormat 的 Responses 预设验证
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <GrokBuildProviderForm
        initialData={{ meta: { apiFormat: "openai_responses" } }}
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.change(document.querySelector('input[name="name"]')!, {
      target: { value: "My route" },
    });
    fireEvent.change(document.querySelector("#codexBaseUrl")!, {
      target: { value: "https://relay.example.com/v1" },
    });
    await user.type(screen.getByLabelText("API Key"), "secret-key");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0];
    const settings = JSON.parse(submitted.settingsConfig);
    const config = parseToml(settings.config) as any;
    expect(submitted.meta.apiFormat).toBe("openai_responses");
    const selected = config.model[config.models.default];
    expect(selected.api_backend).toBe("responses");
    expect(selected.model).toBe("grok-4.5");
    expect(selected.base_url).toBe("https://relay.example.com/v1");
  }, 15_000);

  it("treats a key not entered yet as a required field, not a format error", () => {
    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText(/Invalid config\.toml/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("填写 API Key 后");

    // The key still reaches the generated config after the user types it.
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "typed-key" },
    });
    expect(
      (screen.getByLabelText("raw-config") as HTMLTextAreaElement).value,
    ).toContain('api_key = "typed-key"');
    expect(screen.queryByText(/填写 API Key 后/)).toBeNull();
  });

  it("offers the fixed api_backend values as a choice", () => {
    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByLabelText(/API Backend/) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect([...select.options].map((option) => option.value)).toEqual([
      "responses",
      "chat_completions",
      "messages",
    ]);
    fireEvent.change(select, { target: { value: "chat_completions" } });
    expect(
      (screen.getByLabelText("raw-config") as HTMLTextAreaElement).value,
    ).toContain('api_backend = "chat_completions"');
  });

  it("renders localized validation feedback for malformed TOML", async () => {
    const onSubmit = vi.fn();
    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "test-key" },
    });
    fireEvent.change(screen.getByLabelText("raw-config"), {
      target: { value: "[models" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "changed-key" },
    });
    expect(screen.getByLabelText("raw-config")).toHaveValue("[models");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByLabelText("raw-config")).toHaveValue("[models");

    expect(screen.getByText(/Invalid config\.toml:/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("preserves semantically invalid raw edits until repaired before saving", async () => {
    const onSubmit = vi.fn();
    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "test-key" },
    });
    const raw = screen.getByLabelText("raw-config") as HTMLTextAreaElement;
    const edited = raw.value
      .replace(
        'base_url = "https://api.chimerahub.org/v1"',
        'base_url = "https://edited.example/v1"',
      )
      .replace(/context_window = \d+/, "context_window = 0");
    fireEvent.change(raw, { target: { value: edited } });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "changed-while-raw-invalid" },
    });
    expect(raw).toHaveValue(edited);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(raw).toHaveValue(edited);
    fireEvent.change(raw, {
      target: {
        value: edited.replace("context_window = 0", "context_window = 123456"),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const config = parseToml(
      JSON.parse(onSubmit.mock.calls[0][0].settingsConfig).config,
    ) as any;
    expect(config.model[config.models.default].base_url).toBe(
      "https://edited.example/v1",
    );
    expect(config.model[config.models.default].context_window).toBe(123456);
  });

  it("loads edit-mode values and does not resubmit stale custom endpoints", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const config = `[models]
default = "existing-profile"

[model."existing-profile"]
model = "grok-upstream"
base_url = "https://existing.example.com/v1"
name = "Existing Relay"
api_key = "existing-key"
api_backend = "responses"
context_window = 250000
`;
    const { container } = render(
      <GrokBuildProviderForm
        providerId="existing-provider"
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
        initialData={{
          name: "Existing Relay",
          settingsConfig: { config },
          meta: {
            custom_endpoints: {
              "https://deleted.example.com/v1": {
                url: "https://deleted.example.com/v1",
                addedAt: 1,
              },
            },
          },
        }}
      />,
    );

    expect(
      container.querySelector<HTMLInputElement>("#grokbuild-profile")?.value,
    ).toBe("existing-profile");
    expect(
      container.querySelector<HTMLInputElement>("#codexBaseUrl")?.value,
    ).toBe("https://existing.example.com/v1");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta.custom_endpoints).toBeUndefined();
  });

  it("keeps hand-written comments when a field is edited and saved", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const config = `# my Grok relay
[models]
default = "grok-4.5" # opened by default

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://old.example.com/v1" # EU
name = "Relay"
api_key = "key"
api_backend = "responses"
context_window = 500000
`;
    const { container } = render(
      <GrokBuildProviderForm
        providerId="relay"
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
        initialData={{
          name: "Relay",
          settingsConfig: { config },
          meta: { apiFormat: "openai_responses" },
        }}
      />,
    );
    fireEvent.change(container.querySelector("#codexBaseUrl")!, {
      target: { value: "https://new.example.com/v1" },
    });
    const raw = screen.getByLabelText("raw-config") as HTMLTextAreaElement;
    expect(raw.value).toBe(
      config.replace(
        'base_url = "https://old.example.com/v1" # EU',
        'base_url = "https://new.example.com/v1" # EU',
      ),
    );
    // A layout the fields can edit in place needs no warning.
    expect(screen.queryByText(/注释会被删除/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(onSubmit.mock.calls[0][0].settingsConfig).config;
    expect(saved).toContain("# my Grok relay");
    expect(saved).toContain('default = "grok-4.5" # opened by default');
    expect(saved).toContain('base_url = "https://new.example.com/v1" # EU');
  });

  it("warns before a field edit would rewrite a commented layout", () => {
    const config = `# dotted keys, written by hand
models.default = "grok-4.5"
model."grok-4.5".model = "grok-4.5"
model."grok-4.5".base_url = "https://a.example/v1"
model."grok-4.5".name = "A"
model."grok-4.5".api_key = "k"
model."grok-4.5".api_backend = "responses"
model."grok-4.5".context_window = 500000
`;
    render(
      <GrokBuildProviderForm
        providerId="dotted"
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
        initialData={{ name: "A", settingsConfig: { config } }}
      />,
    );
    // Shown before anything is edited, and the text is still the user's own.
    expect(screen.getByText(/注释会被删除/)).toBeInTheDocument();
    expect(screen.getByLabelText("raw-config")).toHaveValue(config);
  });

  it("keeps the raw editor open while a broken config is being fixed", () => {
    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const raw = screen.getByLabelText("raw-config") as HTMLTextAreaElement;
    const details = raw.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    const valid = raw.value;
    fireEvent.change(raw, { target: { value: "[models" } });
    expect(details).toHaveAttribute("open");
    fireEvent.change(raw, { target: { value: valid } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(details).toHaveAttribute("open");
  });
});
