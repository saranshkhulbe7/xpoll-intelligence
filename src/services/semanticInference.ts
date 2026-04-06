import type {
  AssertionTargetKind,
  InferredSemantics,
  IntensityBand,
  PollSemanticTemplate,
  RawVote,
  RelationPolarity,
} from "../types";
import { config } from "../config";
import { openaiClient } from "../openai";
import { buildPollFingerprint, buildPollKey } from "./contextBuilder";
import { intensityBandToContribution } from "../utils/intensity";
import {
  extractLikelyEntityName,
  filterEntityAliases,
  hasHighLexicalOverlap,
  isContextualEntityLabel,
  isValidEntityAlias,
  stripOptionLeadIn,
} from "../utils/conceptQuality";
import { normalizeText } from "../utils/text";

type PollTemplateOptionResponse = {
  optionText: string;
  canonicalTargetLabel: string;
  targetKind: string;
  relationFamily: string;
  polarity: string;
  intensityBand: string;
  aliases: string[];
  notes: string[];
};

type PollTemplateResponse = {
  canonicalTopicLabel: string;
  topicAliases: string[];
  options: PollTemplateOptionResponse[];
  notes: string[];
};

export type PollTemplateValidationIssue = {
  code: "topic_equals_target" | "topic_overlaps_target" | "entity_label_has_context";
  message: string;
  optionText?: string;
};

const pollTemplateCache = new Map<string, Promise<PollSemanticTemplate>>();
const REALTIME_MODEL_PATTERN = /realtime/i;

const TARGET_KINDS: AssertionTargetKind[] = ["topic", "position", "entity"];
const POLARITIES: RelationPolarity[] = ["positive", "negative", "neutral"];
const INTENSITY_BANDS: IntensityBand[] = ["weak", "medium", "strong"];

const POLL_TEMPLATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    canonicalTopicLabel: { type: "string" },
    topicAliases: {
      type: "array",
      items: { type: "string" },
    },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          optionText: { type: "string" },
          canonicalTargetLabel: { type: "string" },
          targetKind: { type: "string" },
          relationFamily: { type: "string" },
          polarity: { type: "string" },
          intensityBand: { type: "string" },
          aliases: {
            type: "array",
            items: { type: "string" },
          },
          notes: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "optionText",
          "canonicalTargetLabel",
          "targetKind",
          "relationFamily",
          "polarity",
          "intensityBand",
          "aliases",
          "notes",
        ],
      },
    },
    notes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["canonicalTopicLabel", "topicAliases", "options", "notes"],
} as const;

const templateValidationStats = {
  valid: 0,
  repairedByAlias: 0,
  repairedByModel: 0,
  invalid: 0,
};

function normalizeOptionalValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAliases(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeTargetKind(value: string): AssertionTargetKind | undefined {
  const normalized = value.trim().toLowerCase();
  return TARGET_KINDS.includes(normalized as AssertionTargetKind) ? (normalized as AssertionTargetKind) : undefined;
}

function normalizePolarity(value: string): RelationPolarity | undefined {
  const normalized = value.trim().toLowerCase();
  return POLARITIES.includes(normalized as RelationPolarity) ? (normalized as RelationPolarity) : undefined;
}

function normalizeIntensityBand(value: string): IntensityBand | undefined {
  const normalized = value.trim().toLowerCase();
  return INTENSITY_BANDS.includes(normalized as IntensityBand) ? (normalized as IntensityBand) : undefined;
}

function getSafeIntensityBand(value: unknown): IntensityBand {
  return typeof value === "string" ? normalizeIntensityBand(value) ?? "medium" : "medium";
}

function extractJsonObject(input: string): string {
  const trimmed = input.trim();

  if (trimmed.startsWith("```")) {
    const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeFenceMatch?.[1]) {
      return codeFenceMatch[1].trim();
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Model response did not include a JSON object.");
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function buildPollTemplateCacheKey(vote: RawVote): string {
  return `${buildPollKey(vote)}::${buildPollFingerprint(vote)}`;
}

function buildOptionAliases(args: {
  optionText: string;
  canonicalTargetLabel: string;
  targetKind: AssertionTargetKind;
  pollTitle: string;
  aliases: string[];
}): string[] {
  const derivedAliases = [stripOptionLeadIn(args.optionText)];

  if (args.targetKind === "entity") {
    const entityName = extractLikelyEntityName(args.pollTitle);
    if (entityName) {
      derivedAliases.push(entityName);
    }

    return filterEntityAliases(args.canonicalTargetLabel, [...args.aliases, ...derivedAliases]);
  }

  return normalizeAliases([...args.aliases, ...derivedAliases, args.canonicalTargetLabel]);
}

function normalizeTemplate(args: {
  parsed: PollTemplateResponse;
  vote: RawVote;
}): PollSemanticTemplate {
  const canonicalTopicLabel = normalizeOptionalValue(args.parsed.canonicalTopicLabel);
  if (!canonicalTopicLabel) {
    throw new Error(`OpenAI poll template for ${args.vote.poll.pollId} did not include a canonical topic label.`);
  }

  const normalizedOptions = (args.parsed.options ?? [])
    .map((option) =>
      normalizeTemplateOption(
        option,
        args.vote.poll.options,
        args.vote.poll.title,
      ),
    )
    .filter(Boolean) as PollSemanticTemplate["options"];

  if (normalizedOptions.length !== args.vote.poll.options.length) {
    throw new Error(
      `OpenAI poll template for ${args.vote.poll.pollId} returned ${normalizedOptions.length} option templates for ${args.vote.poll.options.length} poll options.`,
    );
  }

  return {
    pollKey: buildPollKey(args.vote),
    pollFingerprint: buildPollFingerprint(args.vote),
    canonicalTopic: {
      label: canonicalTopicLabel,
      aliases: normalizeAliases(args.parsed.topicAliases ?? []),
    },
    options: normalizedOptions,
    notes: Array.isArray(args.parsed.notes) ? args.parsed.notes.map((note) => note.trim()).filter(Boolean) : [],
  };
}

function buildValidationMessage(issues: PollTemplateValidationIssue[]): string {
  return issues.map((issue) => issue.message).join("; ");
}

export function validatePollSemanticTemplate(args: {
  vote: RawVote;
  template: PollSemanticTemplate;
}): PollTemplateValidationIssue[] {
  const issues: PollTemplateValidationIssue[] = [];
  const topicLabel = args.template.canonicalTopic.label;
  const normalizedTopicLabel = normalizeText(topicLabel);

  for (const option of args.template.options) {
    const normalizedTarget = normalizeText(option.canonicalTargetLabel);

    if (normalizedTopicLabel === normalizedTarget) {
      issues.push({
        code: "topic_equals_target",
        optionText: option.optionText,
        message: `Poll ${args.vote.poll.pollId} produced a topic identical to target "${option.canonicalTargetLabel}".`,
      });
      continue;
    }

    if (hasHighLexicalOverlap(topicLabel, option.canonicalTargetLabel, 0.6)) {
      issues.push({
        code: "topic_overlaps_target",
        optionText: option.optionText,
        message: `Poll ${args.vote.poll.pollId} produced an over-specific topic "${topicLabel}" that overlaps target "${option.canonicalTargetLabel}".`,
      });
    }

    if (option.targetKind === "entity" && isContextualEntityLabel(option.canonicalTargetLabel)) {
      issues.push({
        code: "entity_label_has_context",
        optionText: option.optionText,
        message: `Poll ${args.vote.poll.pollId} produced contextual entity label "${option.canonicalTargetLabel}" instead of a plain entity name.`,
      });
    }
  }

  return issues;
}

export function promoteSafeTemplateAliases(args: {
  vote: RawVote;
  template: PollSemanticTemplate;
}): PollSemanticTemplate | null {
  let changed = false;
  const nextTemplate: PollSemanticTemplate = {
    ...args.template,
    canonicalTopic: {
      ...args.template.canonicalTopic,
      aliases: [...(args.template.canonicalTopic.aliases ?? [])],
    },
    options: args.template.options.map((option) => ({
      ...option,
      aliases: [...(option.aliases ?? [])],
    })),
  };

  const topicAlias = nextTemplate.canonicalTopic.aliases?.find((alias) => {
    const normalizedAlias = normalizeText(alias);
    if (!normalizedAlias) {
      return false;
    }

    return nextTemplate.options.every((option) => {
      const normalizedTarget = normalizeText(option.canonicalTargetLabel);
      return normalizedAlias !== normalizedTarget && !hasHighLexicalOverlap(alias, option.canonicalTargetLabel, 0.6);
    });
  });

  if (topicAlias && normalizeText(topicAlias) !== normalizeText(nextTemplate.canonicalTopic.label)) {
    nextTemplate.canonicalTopic.label = topicAlias;
    changed = true;
  }

  nextTemplate.options = nextTemplate.options.map((option) => {
    if (option.targetKind !== "entity" || !isContextualEntityLabel(option.canonicalTargetLabel)) {
      return option;
    }

    const entityAlias = option.aliases?.find((alias) => !isContextualEntityLabel(alias) && isValidEntityAlias(alias, option.canonicalTargetLabel));
    if (!entityAlias || normalizeText(entityAlias) === normalizeText(option.canonicalTargetLabel)) {
      return option;
    }

    changed = true;
    return {
      ...option,
      canonicalTargetLabel: entityAlias,
    };
  });

  if (!changed) {
    return null;
  }

  return validatePollSemanticTemplate({
    vote: args.vote,
    template: nextTemplate,
  }).length === 0
    ? nextTemplate
    : null;
}

async function repairPollSemanticTemplate(args: {
  vote: RawVote;
  context: string;
  template: PollSemanticTemplate;
  issues: PollTemplateValidationIssue[];
}): Promise<PollSemanticTemplate> {
  const usesRealtimeModel = REALTIME_MODEL_PATTERN.test(config.openai.model);
  const response = await openaiClient.responses.create({
    model: config.openai.model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You repair invalid poll semantic templates.",
              "Return JSON only.",
              "Keep optionText, targetKind, relationFamily, polarity, and intensityBand aligned to the existing template.",
              "Rewrite only invalid labels and aliases.",
              "canonicalTopicLabel must be an issue or subissue noun phrase that is broader than every option target.",
              "Do not make canonicalTopicLabel a poll answer, proposition, or sentence.",
              "For entity options, canonicalTargetLabel must be a plain person or organization name only.",
              "Context such as healthcare, climate, debate, leadership, or policy belongs in canonicalTopicLabel, not in the entity label.",
              "The JSON must have exactly these top-level keys: canonicalTopicLabel, topicAliases, options, notes.",
            ].join(" "),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Poll context:",
              args.context,
              "",
              "Current invalid template:",
              JSON.stringify(args.template, null, 2),
              "",
              "Validation issues:",
              buildValidationMessage(args.issues),
            ].join("\n"),
          },
        ],
      },
    ],
    ...(usesRealtimeModel
      ? {}
      : {
          text: {
            format: {
              type: "json_schema",
              name: "poll_semantic_template_repair",
              strict: true,
              schema: POLL_TEMPLATE_SCHEMA,
            },
          },
        }),
  });

  const outputText = response.output_text?.trim();
  if (!outputText) {
    throw new Error(`OpenAI repair response for poll ${args.vote.poll.pollId} did not include output_text.`);
  }

  const parsed = JSON.parse(usesRealtimeModel ? extractJsonObject(outputText) : outputText) as PollTemplateResponse;
  return normalizeTemplate({
    parsed,
    vote: args.vote,
  });
}

export async function ensureValidPollSemanticTemplate(args: {
  vote: RawVote;
  context: string;
  template: PollSemanticTemplate;
}): Promise<PollSemanticTemplate> {
  const initialIssues = validatePollSemanticTemplate({
    vote: args.vote,
    template: args.template,
  });

  if (initialIssues.length === 0) {
    templateValidationStats.valid += 1;
    return args.template;
  }

  console.warn(
    `[poll_template_validation] ${args.vote.poll.pollId} invalid template: ${buildValidationMessage(initialIssues)}`,
  );

  const aliasPromoted = promoteSafeTemplateAliases({
    vote: args.vote,
    template: args.template,
  });

  if (aliasPromoted) {
    templateValidationStats.repairedByAlias += 1;
    console.warn(`[poll_template_validation] ${args.vote.poll.pollId} repaired via alias promotion.`);
    return aliasPromoted;
  }

  const repairedTemplate = await repairPollSemanticTemplate({
    vote: args.vote,
    context: args.context,
    template: args.template,
    issues: initialIssues,
  });
  const repairedIssues = validatePollSemanticTemplate({
    vote: args.vote,
    template: repairedTemplate,
  });

  if (repairedIssues.length === 0) {
    templateValidationStats.repairedByModel += 1;
    console.warn(`[poll_template_validation] ${args.vote.poll.pollId} repaired via constrained model retry.`);
    return repairedTemplate;
  }

  templateValidationStats.invalid += 1;
  throw new Error(
    `Poll template for ${args.vote.poll.pollId} remained invalid after repair: ${buildValidationMessage(repairedIssues)}`,
  );
}

function normalizeTemplateOption(
  option: PollTemplateOptionResponse,
  pollOptions: RawVote["poll"]["options"],
  pollTitle: string,
): PollSemanticTemplate["options"][number] | null {
  const matchedOption = pollOptions.find((pollOption) => normalizeText(pollOption.text) === normalizeText(option.optionText));
  const targetKind = normalizeTargetKind(option.targetKind);
  const polarity = normalizePolarity(option.polarity);
  const intensityBand = normalizeIntensityBand(option.intensityBand);
  const canonicalTargetLabel = normalizeOptionalValue(option.canonicalTargetLabel);
  const relationFamily = normalizeOptionalValue(option.relationFamily);

  if (!matchedOption || !targetKind || !polarity || !canonicalTargetLabel || !relationFamily || !intensityBand) {
    return null;
  }

  return {
    optionText: matchedOption.text,
    canonicalTargetLabel,
    targetKind,
    relationFamily,
    polarity,
    intensityBand,
    aliases: buildOptionAliases({
      optionText: matchedOption.text,
      canonicalTargetLabel,
      targetKind,
      pollTitle,
      aliases: normalizeAliases(option.aliases ?? []),
    }),
    notes: Array.isArray(option.notes) ? option.notes.map((note) => note.trim()).filter(Boolean) : [],
  };
}

export async function inferPollSemanticTemplate(
  vote: RawVote,
  context: string,
): Promise<PollSemanticTemplate> {
  const cacheKey = buildPollTemplateCacheKey(vote);
  const cached = pollTemplateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const usesRealtimeModel = REALTIME_MODEL_PATTERN.test(config.openai.model);
    const response = await openaiClient.responses.create({
      model: config.openai.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You canonicalize a poll once so every vote on that poll can reuse the same semantic vocabulary.",
                "Return JSON only.",
                "Return one issue or subissue canonical topic for the whole poll.",
                "Return one semantic interpretation for each poll option.",
                "Use target kinds only from: topic, position, entity.",
                "Use concise stable canonical labels.",
                "canonicalTopicLabel must be broader than every option target.",
                "canonicalTopicLabel must be an issue noun phrase, not a proposition, vote option, stance sentence, or direct poll answer.",
                "Good topic example: legal status for undocumented immigrants.",
                "Bad topic example: provide pathway to citizenship for undocumented immigrants after background checks.",
                "For policy propositions, use targetKind=position.",
                "For entity sentiment polls, use targetKind=entity and make canonicalTargetLabel the plain entity name only, such as Bernie Sanders or Joe Biden.",
                "Put healthcare, climate, debate, policy, or leadership context in canonicalTopicLabel, not inside the entity label.",
                "If one option clearly opposes another option's proposition, reuse the same canonicalTargetLabel and set polarity to negative instead of inventing a new target.",
                "Use relationFamily only from: support, preference, sentiment, uncertainty.",
                "Use polarity only from: positive, negative, neutral.",
                "Assign intensityBand only from: weak, medium, strong.",
                "Use strong for clear emphatic or direct commitments, medium for compromise or conditional positions, and weak for hesitant, mixed, or low-commitment positions.",
                "Provide 2 to 4 short alias phrases for the topic and for each option target when possible.",
                "The JSON must have exactly these top-level keys: canonicalTopicLabel, topicAliases, options, notes.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: context }],
        },
      ],
      ...(usesRealtimeModel
        ? {}
        : {
            text: {
              format: {
                type: "json_schema",
                name: "poll_semantic_template",
                strict: true,
                schema: POLL_TEMPLATE_SCHEMA,
              },
            },
          }),
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error(`OpenAI response for poll ${vote.poll.pollId} did not include output_text.`);
    }

    const parsed = JSON.parse(usesRealtimeModel ? extractJsonObject(outputText) : outputText) as PollTemplateResponse;
    const normalizedTemplate = normalizeTemplate({
      parsed,
      vote,
    });

    return ensureValidPollSemanticTemplate({
      vote,
      context,
      template: normalizedTemplate,
    });
  })();

  pollTemplateCache.set(cacheKey, promise);

  try {
    return await promise;
  } catch (error) {
    pollTemplateCache.delete(cacheKey);
    throw error;
  }
}

export function materializeVoteSemantics(args: {
  vote: RawVote;
  selectedOption: string;
  template: PollSemanticTemplate;
}): InferredSemantics {
  const option = args.template.options.find(
    (candidate) => normalizeText(candidate.optionText) === normalizeText(args.selectedOption),
  );

  if (!option) {
    throw new Error(
      `Poll template ${args.template.pollKey} did not contain selected option "${args.selectedOption}" for vote ${args.vote.voteId}.`,
    );
  }

  const intensityBand = getSafeIntensityBand(option.intensityBand);

  return {
    assertions: [
      {
        relationFamily: option.relationFamily,
        polarity: option.polarity,
        targetLabel: option.canonicalTargetLabel,
        targetKind: option.targetKind,
        aboutTopicLabel: args.template.canonicalTopic.label,
        confidence: 0.95,
        intensityBand,
        baseIntensityContribution: intensityBandToContribution(intensityBand),
        notes: Array.from(
          new Set([
            ...args.template.notes,
            ...option.notes,
            `Selected option: ${option.optionText}`,
          ]),
        ),
      },
    ],
    notes: Array.from(new Set(args.template.notes)),
  };
}
