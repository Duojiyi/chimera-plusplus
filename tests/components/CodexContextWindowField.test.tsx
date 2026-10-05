import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodexContextWindowField } from "@/components/providers/CodexContextWindowField";

const PRESET =
  "model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n";
const NOTE = "检测到手动设置的上下文值，关闭开关不会改动它们。";

/** Holds the config text the way the line editor does. */
function Editor({
  initial,
  onChange,
}: {
  initial: string;
  onChange: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <CodexContextWindowField
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

const getSwitch = () => screen.getByRole("switch", { name: "1M 上下文" });

describe("CodexContextWindowField", () => {
  it("names the switch and explains what it changes", () => {
    render(
      <CodexContextWindowField
        value={'model = "gpt-5.5"\n'}
        onChange={vi.fn()}
      />,
    );
    const toggle = getSwitch();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription(
      "让 Codex 按 1,000,000 tokens 的上下文窗口使用这条线路的模型，并推迟自动压缩。 " +
        "仅在供应商和模型确实支持 1M 时开启，否则请求可能失败。未单独填写上下文的模型映射，默认窗口也会改为 1M。",
    );
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("writes the preset into the line text", async () => {
    const onChange = vi.fn();
    render(<Editor initial={'model = "gpt-5.5"\n'} onChange={onChange} />);
    await userEvent.click(getSwitch());
    expect(onChange).toHaveBeenCalledWith(`model = "gpt-5.5"\n${PRESET}`);
    expect(getSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("toggles from the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Editor initial="" onChange={onChange} />);
    await user.tab();
    expect(getSwitch()).toHaveFocus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(PRESET);
    expect(getSwitch()).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(getSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("restores a hand-set window when turned straight back off", async () => {
    const original = "model_context_window = 256000 # 原值\n";
    const onChange = vi.fn();
    render(<Editor initial={original} onChange={onChange} />);
    expect(screen.getByText(NOTE)).toBeVisible();
    await userEvent.click(getSwitch());
    expect(onChange).toHaveBeenLastCalledWith(
      "model_context_window = 1000000 # 原值\nmodel_auto_compact_token_limit = 900000\n",
    );
    await userEvent.click(getSwitch());
    expect(onChange).toHaveBeenLastCalledWith(original);
  });

  it("keeps a hand-set limit when turned off and says so", async () => {
    const onChange = vi.fn();
    render(
      <CodexContextWindowField
        value={
          "model_context_window = 1000000\nmodel_auto_compact_token_limit = 850000\n"
        }
        onChange={onChange}
      />,
    );
    const toggle = getSwitch();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription(new RegExp(NOTE));
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(
      "model_auto_compact_token_limit = 850000\n",
    );
  });

  it("does nothing while disabled", async () => {
    const onChange = vi.fn();
    render(<CodexContextWindowField value="" onChange={onChange} disabled />);
    expect(getSwitch()).toBeDisabled();
    await userEvent.click(getSwitch());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("explains why it cannot edit a config with a syntax error", () => {
    const onChange = vi.fn();
    render(
      <CodexContextWindowField
        value={'model = "gpt-5.5\n'}
        onChange={onChange}
      />,
    );
    const toggle = getSwitch();
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(
      /配置文本有误，修正后才能使用这个开关。/,
    );
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});
