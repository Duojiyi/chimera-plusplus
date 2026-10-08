import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderAdvancedConfig, type PricingModelSourceOption } from "@/components/providers/forms/ProviderAdvancedConfig";

function Harness() {
  const [config, setConfig] = useState({ enabled: false, pricingModelSource: "inherit" as PricingModelSourceOption });
  return <ProviderAdvancedConfig pricingConfig={config} onPricingConfigChange={setConfig} />;
}
describe("provider pricing disclosure", () => {
  it("separates the switch from the disclosure and hides collapsed controls", () => {
    const { container } = render(<Harness />);
    const toggle = screen.getByRole("button", { name: "计费配置" });
    const enabled = screen.getByRole("switch", { name: "使用单独配置" });
    expect(container.querySelector("button button")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    fireEvent.click(enabled);
    expect(enabled).toBeChecked();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("spinbutton", { name: "成本倍率" })).toBeEnabled();
    fireEvent.click(toggle);
    expect(enabled).toBeChecked();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });
});
