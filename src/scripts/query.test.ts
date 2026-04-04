import { describe, expect, test } from "bun:test";
import { parseQueryCliArgs } from "./query";

describe("parseQueryCliArgs", () => {
  test("fails cleanly when --ask is missing", () => {
    expect(() => parseQueryCliArgs([])).toThrow('Missing required --ask "<question>" argument.');
  });

  test("supports --limit and --json", () => {
    expect(
      parseQueryCliArgs([
        "--ask",
        "What are Maya Sen's strongest current views?",
        "--limit",
        "7",
        "--json",
      ]),
    ).toEqual({
      ask: "What are Maya Sen's strongest current views?",
      limit: 7,
      json: true,
    });
  });

  test("joins multi-token questions passed through package-script forwarding", () => {
    expect(
      parseQueryCliArgs([
        "--ask",
        "How",
        "does",
        "Maya",
        "Sen",
        "feel",
        "about",
        "Joe",
        "Biden?",
        "--limit",
        "3",
      ]),
    ).toEqual({
      ask: "How does Maya Sen feel about Joe Biden?",
      limit: 3,
      json: false,
    });
  });

  test("rejects invalid limits", () => {
    expect(() => parseQueryCliArgs(["--ask", "Hello", "--limit", "0"])).toThrow("--limit must be a positive integer.");
  });
});
