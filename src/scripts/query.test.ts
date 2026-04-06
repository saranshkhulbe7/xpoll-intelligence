import { describe, expect, test } from "bun:test";
import { formatConceptInspectionReport, parseQueryCliArgs } from "./query";

describe("parseQueryCliArgs", () => {
  test("fails cleanly when no mode is provided", () => {
    expect(() => parseQueryCliArgs([])).toThrow('Missing required --ask "<question>" or --inspect-concept "<concept>" argument.');
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
      inspectConcept: "",
      limit: 7,
      json: true,
      inspectJson: false,
      traceJson: false,
      noTrace: false,
      showPrompts: false,
      maxSteps: undefined,
      maxLlmCalls: undefined,
      maxGraphQueries: undefined,
      maxVectorQueries: undefined,
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
      inspectConcept: "",
      limit: 3,
      json: false,
      inspectJson: false,
      traceJson: false,
      noTrace: false,
      showPrompts: false,
      maxSteps: undefined,
      maxLlmCalls: undefined,
      maxGraphQueries: undefined,
      maxVectorQueries: undefined,
    });
  });

  test("supports reasoning trace and budget flags", () => {
    expect(
      parseQueryCliArgs([
        "--ask",
        "What does Ethan Clark think about immigration?",
        "--trace-json",
        "--show-prompts",
        "--max-steps",
        "9",
        "--max-llm-calls",
        "4",
        "--max-graph-queries",
        "6",
        "--max-vector-queries",
        "2",
      ]),
    ).toEqual({
      ask: "What does Ethan Clark think about immigration?",
      inspectConcept: "",
      limit: 5,
      json: false,
      inspectJson: false,
      traceJson: true,
      noTrace: false,
      showPrompts: true,
      maxSteps: 9,
      maxLlmCalls: 4,
      maxGraphQueries: 6,
      maxVectorQueries: 2,
    });
  });

  test("rejects invalid limits", () => {
    expect(() => parseQueryCliArgs(["--ask", "Hello", "--limit", "0"])).toThrow("--limit must be a positive integer.");
  });

  test("supports concept inspection mode", () => {
    expect(
      parseQueryCliArgs([
        "--inspect-concept",
        "renewable",
        "energy",
        "--limit",
        "4",
        "--inspect-json",
      ]),
    ).toEqual({
      ask: "",
      inspectConcept: "renewable energy",
      limit: 4,
      json: false,
      inspectJson: true,
      traceJson: false,
      noTrace: false,
      showPrompts: false,
      maxSteps: undefined,
      maxLlmCalls: undefined,
      maxGraphQueries: undefined,
      maxVectorQueries: undefined,
    });
  });

  test("rejects mixing query and inspection modes", () => {
    expect(() => parseQueryCliArgs([
      "--ask",
      "Who is negative toward Joe Biden?",
      "--inspect-concept",
      "renewable energy",
    ])).toThrow('Use either --ask "<question>" or --inspect-concept "<concept>", not both.');
  });
});

describe("formatConceptInspectionReport", () => {
  test("renders a stable human-readable inspection summary", () => {
    const report = formatConceptInspectionReport({
      query: "renewable energy",
      normalizedQuery: "renewable energy",
      allowedKinds: ["topic", "position", "entity"],
      exactHits: [],
      aliasHits: [],
      vectorAcceptedHits: [],
      vectorCandidates: [
        {
          canonicalId: "subject:topic:government_spending_on_clean_energy",
          label: "government spending on clean energy",
          kind: "topic",
          aliases: ["public investment in renewables"],
          matchType: "vector",
          matchScore: 0.99,
          matchedQuery: "renewable energy",
          accepted: false,
          rejectionReason: "lexical_overlap_below_threshold",
          threshold: 0.97,
          semanticCoverage: 1,
          lexicalOverlap: 0.18,
        },
      ],
      graphCandidates: [
        {
          canonicalId: "subject:topic:government_spending_on_clean_energy",
          label: "government spending on clean energy",
          kind: "topic",
          topicCanonicalId: null,
          assertionCount: 6,
          lexicalOverlap: 0.18,
          semanticCoverage: 1,
          accepted: true,
        },
      ],
      graphFallbackHits: [
        {
          canonicalId: "subject:topic:government_spending_on_clean_energy",
          label: "government spending on clean energy",
          kind: "topic",
          aliases: [],
          matchType: "graph_fallback",
          matchScore: 1.02,
          matchedQuery: "renewable energy",
        },
      ],
      rootCause: "different_label_or_alias_gap",
    });

    expect(report).toContain("Concept Inspection");
    expect(report).toContain("- Root cause: different_label_or_alias_gap");
    expect(report).toContain("Registry exact hits:");
    expect(report).toContain("Raw vector candidates:");
    expect(report).toContain("rejectionReason: lexical_overlap_below_threshold");
    expect(report).toContain("Graph fallback hits:");
  });
});
