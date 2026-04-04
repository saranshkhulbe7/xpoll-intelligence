import { describe, expect, test } from "bun:test";
import { parseProcessTillFirstNVotes } from "./processLimit";

describe("parseProcessTillFirstNVotes", () => {
  test("returns null for undefined, blank, and literal null", () => {
    expect(parseProcessTillFirstNVotes(undefined)).toBeNull();
    expect(parseProcessTillFirstNVotes("")).toBeNull();
    expect(parseProcessTillFirstNVotes(" null ")).toBeNull();
  });

  test("parses a positive integer limit", () => {
    expect(parseProcessTillFirstNVotes("10")).toBe(10);
  });

  test("rejects non-positive or non-integer values", () => {
    expect(() => parseProcessTillFirstNVotes("0")).toThrow(
      "PROCESS_TILL_FIRST_N_VOTES must be a positive integer or null.",
    );
    expect(() => parseProcessTillFirstNVotes("-5")).toThrow(
      "PROCESS_TILL_FIRST_N_VOTES must be a positive integer or null.",
    );
    expect(() => parseProcessTillFirstNVotes("1.5")).toThrow(
      "PROCESS_TILL_FIRST_N_VOTES must be a positive integer or null.",
    );
    expect(() => parseProcessTillFirstNVotes("abc")).toThrow(
      "PROCESS_TILL_FIRST_N_VOTES must be a positive integer or null.",
    );
  });
});
