import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Alert, AlertDescription } from "@/components/ui/alert";

describe("Alert", () => {
  it("announces only errors as urgent alerts", () => {
    render(
      <>
        <Alert variant="destructive">
          <AlertDescription>出错了</AlertDescription>
        </Alert>
        <Alert>
          <AlertDescription>提示信息</AlertDescription>
        </Alert>
      </>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("出错了");
    expect(screen.getByRole("note")).toHaveTextContent("提示信息");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("keeps an explicitly requested role", () => {
    render(<Alert role="status">保存完成</Alert>);

    expect(screen.getByRole("status")).toHaveTextContent("保存完成");
  });
});
