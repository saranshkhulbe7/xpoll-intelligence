import type {
  AssertionTargetKind,
  InferredSemantics,
  PollSemanticTemplate,
  RawVote,
  RelationPolarity,
} from "../types";
import { config } from "../config";
import { openaiClient } from "../openai";
import { buildPollFingerprint, buildPollKey } from "./contextBuilder";
import { normalizeText } from "../utils/text";

type PollTemplateOptionResponse = {
  optionText: string;
  canonicalTargetLabel: string;
  targetKind: string;
  relationFamily: string;
  polarity: string;
  aliases: string[];
  notes: string[];
};

type PollTemplateResponse = {
  canonicalTopicLabel: string;
  topicAliases: string[];
  options: PollTemplateOptionResponse[];
  notes: string[];
};

const pollTemplateCache = new Map<string, Promise<PollSemanticTemplate>>();
const REALTIME_MODEL_PATTERN = /realtime/i;

const TARGET_KINDS: AssertionTargetKind[] = ["topic", "position", "entity"];
const POLARITIES: RelationPolarity[] = ["positive", "negative", "neutral"];

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

function normalizeOptionalValue(value: string): string | undefined {
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

function normalizeTemplateOption(
  option: PollTemplateOptionResponse,
  pollOptions: RawVote["poll"]["options"],
): PollSemanticTemplate["options"][number] | null {
  const matchedOption = pollOptions.find((pollOption) => normalizeText(pollOption.text) === normalizeText(option.optionText));
  const targetKind = normalizeTargetKind(option.targetKind);
  const polarity = normalizePolarity(option.polarity);
  const canonicalTargetLabel = normalizeOptionalValue(option.canonicalTargetLabel);
  const relationFamily = normalizeOptionalValue(option.relationFamily);

  if (!matchedOption || !targetKind || !polarity || !canonicalTargetLabel || !relationFamily) {
    return null;
  }

  return {
    optionText: matchedOption.text,
    canonicalTargetLabel,
    targetKind,
    relationFamily,
    polarity,
    aliases: normalizeAliases(option.aliases ?? []),
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
                "Return one broad canonical topic for the whole poll.",
                "Return one semantic interpretation for each poll option.",
                "Use target kinds only from: topic, position, entity.",
                "Use concise stable canonical labels.",
                "If one option clearly opposes another option's proposition, reuse the same canonicalTargetLabel and set polarity to negative instead of inventing a new target.",
                "Use relationFamily only from: support, preference, sentiment, uncertainty.",
                "Use polarity only from: positive, negative, neutral.",
                "Add short alias phrases when they help later matching, but keep them concise.",
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
    const canonicalTopicLabel = normalizeOptionalValue(parsed.canonicalTopicLabel);
    if (!canonicalTopicLabel) {
      throw new Error(`OpenAI poll template for ${vote.poll.pollId} did not include a canonical topic label.`);
    }

    const normalizedOptions = (parsed.options ?? [])
      .map((option) => normalizeTemplateOption(option, vote.poll.options))
      .filter(Boolean) as PollSemanticTemplate["options"];

    if (normalizedOptions.length !== vote.poll.options.length) {
      throw new Error(
        `OpenAI poll template for ${vote.poll.pollId} returned ${normalizedOptions.length} option templates for ${vote.poll.options.length} poll options.`,
      );
    }

    return {
      pollKey: buildPollKey(vote),
      pollFingerprint: buildPollFingerprint(vote),
      canonicalTopic: {
        label: canonicalTopicLabel,
        aliases: normalizeAliases(parsed.topicAliases ?? []),
      },
      options: normalizedOptions,
      notes: Array.isArray(parsed.notes) ? parsed.notes.map((note) => note.trim()).filter(Boolean) : [],
    };
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

  return {
    assertions: [
      {
        relationFamily: option.relationFamily,
        polarity: option.polarity,
        targetLabel: option.canonicalTargetLabel,
        targetKind: option.targetKind,
        aboutTopicLabel: args.template.canonicalTopic.label,
        confidence: 0.95,
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
