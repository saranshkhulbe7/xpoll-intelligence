import { describe, expect, test } from "bun:test";
import { parseDatasetMode, validateDatasetModePath } from "./datasetMode";

describe("parseDatasetMode", () => {
  test("accepts test and main", () => {
    expect(parseDatasetMode("test")).toBe("test");
    expect(parseDatasetMode(" main ")).toBe("main");
  });

  test("rejects invalid values", () => {
    expect(() => parseDatasetMode(undefined)).toThrow("DATASET_MODE must be either test or main.");
    expect(() => parseDatasetMode("staging")).toThrow("DATASET_MODE must be either test or main.");
  });
});

describe("validateDatasetModePath", () => {
  const testDataRoot = "/tmp/xpoll-benchmark-root";
  const benchmarkFile = "/tmp/xpoll-benchmark-root/political-benchmark-100.json";
  const benchmarkDirectory = "/tmp/xpoll-benchmark-root";
  const mainDirectory = "/tmp/xpoll-main-root/decompose";

  test("allows test mode when the resolved path is inside the benchmark directory", () => {
    expect(() =>
      validateDatasetModePath({
        datasetMode: "test",
        resolvedPath: benchmarkFile,
        testDataRoot,
      }),
    ).not.toThrow();

    expect(() =>
      validateDatasetModePath({
        datasetMode: "test",
        resolvedPath: benchmarkDirectory,
        testDataRoot,
      }),
    ).not.toThrow();
  });

  test("fails fast when test mode points at main data", () => {
    expect(() =>
      validateDatasetModePath({
        datasetMode: "test",
        resolvedPath: mainDirectory,
        testDataRoot,
      }),
    ).toThrow("DATASET_MODE=test requires VOTES_JSON_PATH");
  });

  test("fails fast when main mode points at benchmark data", () => {
    expect(() =>
      validateDatasetModePath({
        datasetMode: "main",
        resolvedPath: benchmarkFile,
        testDataRoot,
      }),
    ).toThrow("DATASET_MODE=main cannot be used with benchmark inputs");
  });
});
