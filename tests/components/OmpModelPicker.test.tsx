import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { OmpModelPicker } from "@/views/OmpModelPicker";
import { fetchModelsForConfig } from "@/lib/api/model-fetch";
vi.mock("@/lib/api/model-fetch", () => ({ fetchModelsForConfig: vi.fn() }));
const defaults = {
  baseUrl: "https://api.chimerahub.org/v1",
  apiKey: "sk-example-key",
  api: "openai-completions",
  auth: "apiKey",
};
beforeEach(() => vi.resetAllMocks());
function Form() {
  const [value, onChange] = useState("existing");
  return (
    <>
      <OmpModelPicker {...defaults} value={value} onChange={onChange} />
      <textarea aria-label="selected" value={value} readOnly />
    </>
  );
}
it("fetches, searches and fills selected models without removing existing entries", async () => {
  vi.mocked(fetchModelsForConfig).mockResolvedValue([
    { id: "model-a", ownedBy: null },
    { id: "model-a", ownedBy: null },
    { id: "model-b", ownedBy: null },
  ]);
  render(<Form />);
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "model-a" }));
  expect(screen.getByLabelText("selected")).toHaveValue("existing\nmodel-a");
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("搜索可用模型"), {
    target: { value: "model-b" },
  });
  expect(
    screen.queryByRole("checkbox", { name: "model-a" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "model-b" }));
  expect(screen.getByLabelText("selected")).toHaveValue(
    "existing\nmodel-a\nmodel-b",
  );
  expect(fetchModelsForConfig).toHaveBeenCalledWith(
    defaults.baseUrl,
    defaults.apiKey,
  );
});
it("does not send environment variable names and keeps discovery credentials out of saved data", async () => {
  const onChange = vi.fn();
  vi.mocked(fetchModelsForConfig).mockResolvedValue([]);
  render(
    <OmpModelPicker
      {...defaults}
      apiKey="CHIMERA_API_KEY"
      value="existing"
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  expect(fetchModelsForConfig).not.toHaveBeenCalled();
  fireEvent.change(
    screen.getByLabelText("用于获取模型的 API Key", { exact: false }),
    { target: { value: "sk-temporary" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  await screen.findByText("服务商未返回模型，可手动填写模型 ID。");
  expect(fetchModelsForConfig).toHaveBeenCalledWith(
    defaults.baseUrl,
    "sk-temporary",
  );
  expect(onChange).not.toHaveBeenCalled();
});
it("discards responses after the address changes", async () => {
  let resolve!: (models: { id: string; ownedBy: null }[]) => void;
  vi.mocked(fetchModelsForConfig).mockReturnValue(
    new Promise((r) => (resolve = r)),
  );
  const props = { ...defaults, value: "existing", onChange: vi.fn() };
  const view = render(<OmpModelPicker {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  view.rerender(
    <OmpModelPicker {...props} baseUrl="https://other.example/v1" />,
  );
  resolve([{ id: "stale-model", ownedBy: null }]);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "获取模型列表" })).toBeEnabled(),
  );
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(props.onChange).not.toHaveBeenCalled();
});
it("keeps manual entries and does not expose service error secrets", async () => {
  vi.mocked(fetchModelsForConfig).mockRejectedValue(new Error("sk-secret"));
  render(<Form />);
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  await screen.findByText(/获取失败/);
  expect(screen.queryByText(/sk-secret/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("selected")).toHaveValue("existing");
});
