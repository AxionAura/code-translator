import { describe, expect, it } from "vitest";
import { Point, Rect, unit_rect } from "../geometry.ts";
import {
  __ctrans_callMethod,
  __ctrans_dictPop,
  __ctrans_eq,
  __ctrans_floatStr,
  __ctrans_getattr,
  __ctrans_iter,
  __ctrans_listCount,
  __ctrans_listIndex,
  __ctrans_listRemove,
  __ctrans_setRemove,
  __ctrans_str,
  __ctrans_strCapitalize,
  __ctrans_strJoin,
  __ctrans_strSplit,
} from "../__ctrans_runtime.ts";
function fixture_origin() {
  return new Point(0, 0);
}
function fixture_rect() {
  return new Rect(0, 0, 10, 5);
}
it("test_translated", () => {
  let origin = fixture_origin();
  let moved = __ctrans_callMethod(origin, "translated", 3, -2);
  expect(__ctrans_callMethod(moved, "key")).toEqual([3, -2]);
});
it("test_contains_true", () => {
  let rect = fixture_rect();
  expect(__ctrans_callMethod(rect, "contains", new Point(9, 4))).toBe(true);
});
it("test_contains_false", () => {
  let rect = fixture_rect();
  expect(__ctrans_callMethod(rect, "contains", new Point(10, 4))).toBe(false);
});
it("test_unit_rect_area", () => {
  expect(__ctrans_callMethod(unit_rect(), "area")).toEqual(1);
});
describe("TestRect", () => {
  it("test_area", () => {
    expect(__ctrans_callMethod(new Rect(2, 3, 4, 5), "area")).toEqual(20);
  });
  it("test_contains_corner_only", () => {
    let rect = new Rect(0, 0, 2, 2);
    expect(rect.contains(new Point(0, 0))).toBe(true);
    expect(rect.contains(new Point(2, 2))).toBe(false);
  });
});
