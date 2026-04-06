import { closeNeo4j, verifyNeo4jConnection } from "../db/neo4j";
import { verifyQdrantConnection } from "../db/qdrant";
import { runReasoningDrivenTerminalGraphQuery, type QueryTraceOptions, type ReasoningStep } from "../services/queryReasoning";
import { inspectConceptResolution, type ConceptResolutionInspection } from "../services/queryRag";

export type QueryCliArgs = {
  ask: string;
  inspectConcept: string;
  limit: number;
  json: boolean;
  inspectJson: boolean;
  traceJson: boolean;
  noTrace: boolean;
  showPrompts: boolean;
  maxSteps?: number;
  maxLlmCalls?: number;
  maxGraphQueries?: number;
  maxVectorQueries?: number;
};

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }

  return parsed;
}

export function parseQueryCliArgs(argv: string[]): QueryCliArgs {
  let ask = "";
  let inspectConcept = "";
  let limit = 5;
  let json = false;
  let inspectJson = false;
  let traceJson = false;
  let noTrace = false;
  let showPrompts = false;
  let maxSteps: number | undefined;
  let maxLlmCalls: number | undefined;
  let maxGraphQueries: number | undefined;
  let maxVectorQueries: number | undefined;
  const knownFlags = new Set([
    "--ask",
    "--inspect-concept",
    "--inspect-json",
    "--limit",
    "--json",
    "--trace-json",
    "--no-trace",
    "--show-prompts",
    "--max-steps",
    "--max-llm-calls",
    "--max-graph-queries",
    "--max-vector-queries",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--ask") {
      const questionParts: string[] = [];
      let cursor = index + 1;

      while (cursor < argv.length && !knownFlags.has(argv[cursor] ?? "")) {
        questionParts.push(argv[cursor] ?? "");
        cursor += 1;
      }

      const value = questionParts.join(" ").trim();
      if (!value) {
        throw new Error("--ask requires a question string.");
      }

      ask = value;
      index = cursor - 1;
      continue;
    }

    if (arg === "--inspect-concept") {
      const conceptParts: string[] = [];
      let cursor = index + 1;

      while (cursor < argv.length && !knownFlags.has(argv[cursor] ?? "")) {
        conceptParts.push(argv[cursor] ?? "");
        cursor += 1;
      }

      const value = conceptParts.join(" ").trim();
      if (!value) {
        throw new Error("--inspect-concept requires a concept string.");
      }

      inspectConcept = value;
      index = cursor - 1;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--limit requires a numeric value.");
      }

      limit = parsePositiveInteger(value, "--limit");
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--inspect-json") {
      inspectJson = true;
      continue;
    }

    if (arg === "--trace-json") {
      traceJson = true;
      continue;
    }

    if (arg === "--no-trace") {
      noTrace = true;
      continue;
    }

    if (arg === "--show-prompts") {
      showPrompts = true;
      continue;
    }

    if (arg === "--max-steps") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--max-steps requires a numeric value.");
      }

      maxSteps = parsePositiveInteger(value, "--max-steps");
      index += 1;
      continue;
    }

    if (arg === "--max-llm-calls") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--max-llm-calls requires a numeric value.");
      }

      maxLlmCalls = parsePositiveInteger(value, "--max-llm-calls");
      index += 1;
      continue;
    }

    if (arg === "--max-graph-queries") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--max-graph-queries requires a numeric value.");
      }

      maxGraphQueries = parsePositiveInteger(value, "--max-graph-queries");
      index += 1;
      continue;
    }

    if (arg === "--max-vector-queries") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--max-vector-queries requires a numeric value.");
      }

      maxVectorQueries = parsePositiveInteger(value, "--max-vector-queries");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (ask.trim() && inspectConcept.trim()) {
    throw new Error('Use either --ask "<question>" or --inspect-concept "<concept>", not both.');
  }

  if (!ask.trim() && !inspectConcept.trim()) {
    throw new Error('Missing required --ask "<question>" or --inspect-concept "<concept>" argument.');
  }

  if (inspectConcept.trim() && json) {
    throw new Error("--json is only supported with --ask. Use --inspect-json for concept inspection.");
  }

  if (ask.trim() && inspectJson) {
    throw new Error("--inspect-json is only supported with --inspect-concept.");
  }

  return {
    ask: ask.trim(),
    inspectConcept: inspectConcept.trim(),
    limit,
    json,
    inspectJson,
    traceJson,
    noTrace,
    showPrompts,
    maxSteps,
    maxLlmCalls,
    maxGraphQueries,
    maxVectorQueries,
  };
}

function formatHit(hit: {
  canonicalId: string;
  label: string;
  kind: string;
  matchScore: number;
  aliases: string[];
}): string {
  const aliases = hit.aliases.length > 0 ? ` | aliases: ${hit.aliases.join(", ")}` : "";
  return `- ${hit.label} (${hit.kind}) | canonicalId: ${hit.canonicalId} | score: ${hit.matchScore.toFixed(2)}${aliases}`;
}

function formatVectorCandidate(candidate: ConceptResolutionInspection["vectorCandidates"][number]): string {
  const aliases = candidate.aliases.length > 0 ? ` | aliases: ${candidate.aliases.join(", ")}` : "";
  return [
    `- ${candidate.label} (${candidate.kind})`,
    `canonicalId: ${candidate.canonicalId}`,
    `score: ${candidate.matchScore.toFixed(2)}`,
    `accepted: ${candidate.accepted ? "yes" : "no"}`,
    `semanticCoverage: ${candidate.semanticCoverage.toFixed(2)}`,
    `lexicalOverlap: ${candidate.lexicalOverlap.toFixed(2)}`,
    `rejectionReason: ${candidate.rejectionReason ?? "none"}`,
    aliases ? aliases.slice(3) : "",
  ].filter(Boolean).join(" | ");
}

function formatGraphCandidate(candidate: ConceptResolutionInspection["graphCandidates"][number]): string {
  return [
    `- ${candidate.label} (${candidate.kind})`,
    `canonicalId: ${candidate.canonicalId}`,
    `accepted: ${candidate.accepted ? "yes" : "no"}`,
    `assertionCount: ${candidate.assertionCount}`,
    `semanticCoverage: ${candidate.semanticCoverage.toFixed(2)}`,
    `lexicalOverlap: ${candidate.lexicalOverlap.toFixed(2)}`,
    candidate.topicCanonicalId ? `topicCanonicalId: ${candidate.topicCanonicalId}` : "",
  ].filter(Boolean).join(" | ");
}

function describeRootCause(rootCause: ConceptResolutionInspection["rootCause"]): string {
  switch (rootCause) {
    case "missing_from_registry":
      return "A usable graph concept exists, but the registry did not surface it.";
    case "different_label_or_alias_gap":
      return "A usable concept exists under a different label or missing alias.";
    case "vector_too_conservative":
      return "Vector search found a semantically relevant candidate, but conservative lexical gating rejected it.";
    case "no_candidate_anywhere":
      return "Neither the registry nor the graph produced a usable concept candidate.";
    default:
      return "The concept resolves cleanly without a diagnosed failure mode.";
  }
}

function pushSection(lines: string[], title: string, entries: string[]): void {
  lines.push("", `${title}:`);
  if (entries.length === 0) {
    lines.push("- none");
    return;
  }

  lines.push(...entries);
}

export function formatConceptInspectionReport(inspection: ConceptResolutionInspection): string {
  const lines = [
    "Concept Inspection",
    `- Query: ${inspection.query}`,
    `- Normalized query: ${inspection.normalizedQuery || "(empty)"}`,
    `- Allowed kinds: ${inspection.allowedKinds.join(", ")}`,
    `- Root cause: ${inspection.rootCause ?? "none"}`,
    `- Interpretation: ${describeRootCause(inspection.rootCause)}`,
  ];

  pushSection(lines, "Registry exact hits", inspection.exactHits.map(formatHit));
  pushSection(lines, "Registry alias hits", inspection.aliasHits.map(formatHit));
  pushSection(lines, "Raw vector candidates", inspection.vectorCandidates.map(formatVectorCandidate));
  pushSection(lines, "Graph candidates", inspection.graphCandidates.map(formatGraphCandidate));
  pushSection(lines, "Graph fallback hits", inspection.graphFallbackHits.map(formatHit));

  return lines.join("\n");
}

function formatReasoningStep(step: ReasoningStep, traceJson: boolean): string {
  if (traceJson) {
    return `${JSON.stringify({
      type: "query_reasoning",
      stepNumber: step.stepNumber,
      phase: step.phase,
      technique: step.technique,
      reason: step.reason,
      action: step.action,
      actionArgs: step.actionArgs,
      observationSummary: step.observationSummary,
      observationData: step.observationData,
      nextStepNeeded: step.nextStepNeeded,
      isRevision: step.isRevision ?? false,
      revisesStep: step.revisesStep ?? null,
      branchId: step.branchId ?? null,
      confidence: step.confidence ?? null,
      budgetSnapshot: step.budgetSnapshot,
      promptPreview: step.promptPreview ?? null,
    })}\n`;
  }

  const lines = [
    `[Reasoning ${step.stepNumber}] Technique: ${step.technique}`,
    `Phase: ${step.phase}`,
    `Reason: ${step.reason}`,
    `Action: ${step.action}`,
  ];

  if (Object.keys(step.actionArgs).length > 0) {
    lines.push(`Action args: ${JSON.stringify(step.actionArgs)}`);
  }

  lines.push("", "[Observation]");
  lines.push(step.observationSummary);

  if (step.observationData) {
    lines.push(JSON.stringify(step.observationData, null, 2));
  }

  if (step.isRevision) {
    lines.push(`Revision: yes${step.revisesStep ? ` (revises step ${step.revisesStep})` : ""}`);
  }

  if (step.branchId) {
    lines.push(`Branch: ${step.branchId}`);
  }

  lines.push(
    `Budget remaining: steps ${step.budgetSnapshot.remainingSteps}, llm ${step.budgetSnapshot.remainingLlmCalls}, graph ${step.budgetSnapshot.remainingGraphQueries}, vector ${step.budgetSnapshot.remainingVectorQueries}, evidence ${step.budgetSnapshot.remainingEvidenceFetchRounds}`,
  );

  if (step.promptPreview) {
    lines.push("", "[Prompt Preview]");
    lines.push(step.promptPreview);
  }

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseQueryCliArgs(process.argv.slice(2));
  const startupWarnings: string[] = [];
  const trace: QueryTraceOptions = {
    enabled: !args.noTrace && !args.json,
    json: args.traceJson,
    showPrompts: args.showPrompts,
    onStep(step) {
      if (args.noTrace || args.json) {
        return;
      }

      process.stdout.write(formatReasoningStep(step, args.traceJson));
    },
  };

  await verifyNeo4jConnection();
  try {
    await verifyQdrantConnection();
  } catch {
    startupWarnings.push(
      "Qdrant verification failed. The query will continue with graph-first retrieval, but concept expansion and raw evidence may be limited.",
    );
  }

  if (args.inspectConcept) {
    const inspection = await inspectConceptResolution({
      query: args.inspectConcept,
      limit: args.limit,
    });

    if (args.inspectJson) {
      console.log(JSON.stringify(inspection, null, 2));
      return;
    }

    const lines = [formatConceptInspectionReport(inspection)];
    if (startupWarnings.length > 0) {
      lines.push("", "Warnings:");
      lines.push(...startupWarnings.map((warning) => `- ${warning}`));
    }

    console.log(lines.join("\n"));
    return;
  }

  const answer = await runReasoningDrivenTerminalGraphQuery({
    question: args.ask,
    limit: args.limit,
    budget: {
      maxSteps: args.maxSteps,
      maxLlmCalls: args.maxLlmCalls,
      maxGraphQueries: args.maxGraphQueries,
      maxVectorQueries: args.maxVectorQueries,
    },
    trace,
  });

  if (startupWarnings.length > 0) {
    answer.warnings = [...startupWarnings, ...answer.warnings];
    if (!args.json) {
      answer.answerText = [answer.answerText, "Warnings:", ...answer.warnings.map((warning) => `- ${warning}`)]
        .filter(Boolean)
        .join("\n");
    }
  }

  if (args.json) {
    console.log(JSON.stringify(answer, null, 2));
    return;
  }

  console.log(answer.answerText);
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeNeo4j();
    });
}
