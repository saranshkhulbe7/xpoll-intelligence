import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  POLITICAL_BENCHMARK_DATA_FILE,
  POLITICAL_BENCHMARK_DATASET_NAME,
  POLITICAL_BENCHMARK_EXPECTED_FILE,
  buildPoliticalBenchmarkBundle,
} from "../testData/politicalBenchmark";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const outputDirectory = resolve(process.cwd(), "db", "test-data");
  const dataFilePath = resolve(outputDirectory, POLITICAL_BENCHMARK_DATA_FILE);
  const expectedFilePath = resolve(outputDirectory, POLITICAL_BENCHMARK_EXPECTED_FILE);
  const bundle = buildPoliticalBenchmarkBundle();

  await writeJson(dataFilePath, bundle.votes);
  await writeJson(expectedFilePath, bundle.manifest);

  console.log(
    `Wrote ${POLITICAL_BENCHMARK_DATASET_NAME} to ${dataFilePath} and ${expectedFilePath}.`,
  );
}

main().catch((error) => {
  console.error("Failed to generate political benchmark files.", error);
  process.exitCode = 1;
});
