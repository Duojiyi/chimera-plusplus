import { describe, expect, it } from "vitest";
import { moveBefore, moveBy } from "@/components/claude-accounts/useSortable";

describe("moveBefore", () => {
  const ids = ["a", "b", "c", "d"];

  it("puts a row dragged up before the one it is dropped on", () => {
    expect(moveBefore(ids, "c", "a")).toEqual(["c", "a", "b", "d"]);
    expect(moveBefore(ids, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("puts a row dragged down after the one it is dropped on", () => {
    expect(moveBefore(ids, "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveBefore(ids, "a", "d")).toEqual(["b", "c", "d", "a"]);
  });

  it("changes nothing for itself or an unknown row", () => {
    expect(moveBefore(ids, "b", "b")).toBe(ids);
    expect(moveBefore(ids, "x", "a")).toBe(ids);
    expect(moveBefore(ids, "a", "x")).toBe(ids);
  });

  it("does not modify the list it was given", () => {
    const copy = [...ids];
    moveBefore(ids, "d", "a");
    expect(ids).toEqual(copy);
  });
});

describe("moveBy", () => {
  const ids = ["a", "b", "c"];

  it("moves one place and stops at the ends", () => {
    expect(moveBy(ids, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveBy(ids, "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveBy(ids, "a", -1)).toBe(ids);
    expect(moveBy(ids, "c", 1)).toBe(ids);
    expect(moveBy(ids, "x", 1)).toBe(ids);
  });
});
