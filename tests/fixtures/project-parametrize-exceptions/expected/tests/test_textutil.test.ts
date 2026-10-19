import { describe, expect, it } from "vitest";
import { initials, is_palindrome, parse_int, word_count } from "../textutil.ts";
import {
  ValueError,
  __ctrans_contains,
  __ctrans_eq,
} from "../__ctrans_runtime.ts";
it.each([
  { text: "7", expected: 7 },
  { text: "-42", expected: -42 },
  { text: "0", expected: 0 },
])("test_parse_int_valid $text $expected", ({ text, expected }) => {
  expect(parse_int(text)).toEqual(expected);
});
it.each([{ text: "12a" }, { text: "x" }, { text: "-" }])(
  "test_parse_int_invalid $text",
  ({ text }) => {
    expect(() => {
      parse_int(text);
    }).toThrow(ValueError);
  },
);
it("test_parse_int_empty_raises", () => {
  expect(() => {
    parse_int("");
  }).toThrow(ValueError);
});
it("test_word_count", () => {
  expect(word_count("a b  c")).toEqual(3);
  expect(word_count("")).toEqual(0);
});
it.each([
  { text: "racecar" },
  { text: "never odd or even" },
  { text: "step on no pets" },
])("test_palindromes $text", ({ text }) => {
  expect(is_palindrome(text)).toBe(true);
});
it.each([{ text: "hello" }, { text: "world" }])(
  "test_not_palindromes $text",
  ({ text }) => {
    expect(is_palindrome(text)).toBe(false);
  },
);
it("test_initials", () => {
  expect(initials("Ada Lovelace Byron")).toEqual("A.L.B.");
});
it("test_parse_int_digits_membership", () => {
  expect(__ctrans_contains("123", "3")).toBe(true);
  expect(__ctrans_contains("123", "9")).toBe(false);
});
