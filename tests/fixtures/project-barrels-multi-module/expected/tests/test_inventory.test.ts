import { describe, expect, it } from "vitest";
import { book_pair } from "../inventory/book.ts";
import { Book, Shelf } from "../inventory/index.ts";
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
function fixture_shelf() {
  return new Shelf();
}
it("test_add_tracks_count", () => {
  let shelf = fixture_shelf();
  expect(__ctrans_callMethod(shelf, "add", new Book("Dune", 412))).toEqual(1);
  expect(__ctrans_callMethod(shelf, "add", new Book("Circe", 393))).toEqual(2);
});
it("test_total_pages", () => {
  let shelf = fixture_shelf();
  for (const book of __ctrans_iter(book_pair())) {
    __ctrans_callMethod(shelf, "add", book);
  }
  expect(__ctrans_callMethod(shelf, "total_pages")).toEqual(805);
});
it("test_find_present_and_missing", () => {
  let shelf = fixture_shelf();
  __ctrans_callMethod(shelf, "add", new Book("Dune", 412));
  expect(__ctrans_callMethod(shelf, "find", "Dune")).not.toBe(undefined);
  expect(__ctrans_callMethod(shelf, "find", "Nope")).toBe(undefined);
});
describe("TestBook", () => {
  it("test_blurb", () => {
    let book = new Book("Circe", 393);
    expect(book.blurb()).toEqual("Circe (393 pages)");
  });
});
it("test_titles_order", () => {
  let shelf = fixture_shelf();
  for (const book of __ctrans_iter(book_pair())) {
    __ctrans_callMethod(shelf, "add", book);
  }
  expect(__ctrans_callMethod(shelf, "titles")).toEqual(["Dune", "Circe"]);
});
