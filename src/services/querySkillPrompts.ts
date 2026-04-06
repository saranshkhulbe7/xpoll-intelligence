import { readFile } from "node:fs/promises";
import path from "node:path";
import type { QueryIntentType } from "./queryRag";

export type QuerySkillName =
  | "sequential-thinking"
  | "thought-based-reasoning"
  | "second-order-thinking";

type QuerySkillFile = {
  path: string;
  required?: boolean;
};

type QuerySkillConfig = {
  files: QuerySkillFile[];
};

const QUERY_SKILL_ROOT = path.resolve(process.cwd(), "prompts/query-llm/skills");

const QUERY_SKILL_CONFIG: Record<QuerySkillName, QuerySkillConfig> = {
  "sequential-thinking": {
    files: [
      { path: "sequential-thinking/SKILL.md", required: true },
      { path: "sequential-thinking/references/advanced.md" },
      { path: "sequential-thinking/references/examples.md" },
    ],
  },
  "thought-based-reasoning": {
    files: [{ path: "thought-based-reasoning/SKILL.md", required: true }],
  },
  "second-order-thinking": {
    files: [{ path: "second-order-thinking/SKILL.md", required: true }],
  },
};

let cachedSkillBundlePromise: Promise<Record<QuerySkillName, string>> | null = null;

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function loadInstalledQuerySkillTexts(): Promise<Record<QuerySkillName, string>> {
  const entries = await Promise.all(
    (Object.entries(QUERY_SKILL_CONFIG) as Array<[QuerySkillName, QuerySkillConfig]>).map(async ([skillName, config]) => {
      const parts: string[] = [];
      for (const file of config.files) {
        const absolutePath = path.join(QUERY_SKILL_ROOT, file.path);
        const text = await readOptionalText(absolutePath);
        if (!text) {
          if (file.required) {
            parts.push(`File missing: ${absolutePath}`);
          }
          continue;
        }

        parts.push(`## Source: ${file.path}\n${text.trim()}`);
      }

      return [skillName, parts.join("\n\n").trim()] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<QuerySkillName, string>;
}

export async function getInstalledQuerySkillTexts(): Promise<Record<QuerySkillName, string>> {
  if (!cachedSkillBundlePromise) {
    cachedSkillBundlePromise = loadInstalledQuerySkillTexts();
  }

  return cachedSkillBundlePromise;
}

export function routeQueryReasoningSkills(args: {
  question: string;
  intentType?: QueryIntentType | null;
  hasCohorts?: boolean;
  multipleConceptClusters?: boolean;
  isGapReflection?: boolean;
}): QuerySkillName[] {
  const normalizedQuestion = args.question.trim().toLowerCase();
  const skills = new Set<QuerySkillName>(["sequential-thinking"]);

  if (
    args.isGapReflection
    || args.multipleConceptClusters
    || args.intentType === "user_concept_summary"
    || args.intentType === "concept_cohort_summary"
    || normalizedQuestion.includes("compare ")
    || normalizedQuestion.includes("percentage")
  ) {
    skills.add("thought-based-reasoning");
  }

  if (
    args.hasCohorts
    || args.multipleConceptClusters
    || args.intentType === "concept_cohort_summary"
    || normalizedQuestion.includes("compare ")
    || normalizedQuestion.includes("percentage")
    || normalizedQuestion.includes("overall")
  ) {
    skills.add("second-order-thinking");
  }

  return Array.from(skills);
}

export async function buildQuerySkillGuidance(args: {
  techniques: QuerySkillName[];
  maxChars?: number;
}): Promise<string> {
  const skillTexts = await getInstalledQuerySkillTexts();
  const combined = args.techniques
    .map((technique) => `# Skill Module: ${technique}\n${skillTexts[technique] ?? ""}`.trim())
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    return "";
  }

  const maxChars = args.maxChars ?? 12000;
  return combined.length <= maxChars ? combined : `${combined.slice(0, maxChars)}\n\n[truncated]`;
}
