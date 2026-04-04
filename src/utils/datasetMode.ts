import { resolve, sep } from "node:path";
import type { DatasetMode } from "../types";

export function parseDatasetMode(value: string | undefined): DatasetMode {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "test" || normalized === "main") {
    return normalized;
  }

  throw new Error("DATASET_MODE must be either test or main.");
}

function ensureTrailingSeparator(input: string): string {
  return input.endsWith(sep) ? input : `${input}${sep}`;
}

function isPathWithinRoot(inputPath: string, rootPath: string): boolean {
  return inputPath === rootPath || inputPath.startsWith(ensureTrailingSeparator(rootPath));
}

export function validateDatasetModePath(args: {
  datasetMode: DatasetMode;
  resolvedPath: string;
  testDataRoot?: string;
}): void {
  const testDataRoot = resolve(args.testDataRoot ?? resolve(process.cwd(), "db", "test-data"));
  const usesTestDataPath = isPathWithinRoot(args.resolvedPath, testDataRoot);

  if (args.datasetMode === "test" && !usesTestDataPath) {
    throw new Error(
      `DATASET_MODE=test requires VOTES_JSON_PATH to resolve inside ${testDataRoot}. Received: ${args.resolvedPath}`,
    );
  }

  if (args.datasetMode === "main" && usesTestDataPath) {
    throw new Error(
      `DATASET_MODE=main cannot be used with benchmark inputs inside ${testDataRoot}. Received: ${args.resolvedPath}`,
    );
  }
}
