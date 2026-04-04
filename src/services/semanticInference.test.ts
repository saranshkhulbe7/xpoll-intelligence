import { afterEach, describe, expect, test } from "bun:test";
import { openaiClient } from "../openai";
import type { PollSemanticTemplate, RawVote } from "../types";
import {
  ensureValidPollSemanticTemplate,
  validatePollSemanticTemplate,
} from "./semanticInference";

const originalCreate = openaiClient.responses.create.bind(openaiClient.responses);

afterEach(() => {
  openaiClient.responses.create = originalCreate;
});

function createVote(title: string): RawVote {
  return {
    voteId: "vote-1",
    type: "standalone_poll",
    voter: {
      externalAccountId: "user-1",
    },
    poll: {
      pollId: "poll-1",
      title,
      options: [
        { text: "Option A", isSelected: true },
        { text: "Option B", isSelected: false },
      ],
    },
  };
}

describe("validatePollSemanticTemplate", () => {
  test("flags contextual entity labels", () => {
    const vote = createVote("Did Bernie Sanders push the healthcare debate in a helpful direction?");
    const template: PollSemanticTemplate = {
      pollKey: "poll:poll-1",
      pollFingerprint: "poll-fingerprint-1",
      canonicalTopic: {
        label: "healthcare debate",
        aliases: ["healthcare reform debate"],
      },
      options: [
        {
          optionText: "Option A",
          canonicalTargetLabel: "Bernie Sanders' impact on the healthcare debate",
          targetKind: "entity",
          relationFamily: "sentiment",
          polarity: "positive",
          intensityBand: "strong",
          aliases: ["Bernie Sanders"],
          notes: [],
        },
      ],
      notes: [],
    };

    const issues = validatePollSemanticTemplate({
      vote,
      template,
    });

    expect(issues.map((issue) => issue.code)).toContain("entity_label_has_context");
  });
});

describe("ensureValidPollSemanticTemplate", () => {
  test("repairs an over-specific topic by promoting a safe alias without calling OpenAI", async () => {
    const vote = createVote("Should undocumented immigrants who pass background checks get a path to citizenship?");
    const template: PollSemanticTemplate = {
      pollKey: "poll:poll-1",
      pollFingerprint: "poll-fingerprint-1",
      canonicalTopic: {
        label: "Pathway to citizenship after background checks",
        aliases: ["legal status for undocumented immigrants"],
      },
      options: [
        {
          optionText: "Option A",
          canonicalTargetLabel: "Pathway to citizenship after background checks",
          targetKind: "position",
          relationFamily: "support",
          polarity: "positive",
          intensityBand: "strong",
          aliases: ["citizenship pathway after screening"],
          notes: [],
        },
        {
          optionText: "Option B",
          canonicalTargetLabel: "Temporary work permits without citizenship",
          targetKind: "position",
          relationFamily: "preference",
          polarity: "positive",
          intensityBand: "medium",
          aliases: ["temporary work status only"],
          notes: [],
        },
      ],
      notes: [],
    };

    openaiClient.responses.create = (async () => {
      throw new Error("OpenAI repair should not run when alias promotion succeeds.");
    }) as unknown as typeof openaiClient.responses.create;

    const repaired = await ensureValidPollSemanticTemplate({
      vote,
      context: "poll context",
      template,
    });

    expect(repaired.canonicalTopic.label).toBe("legal status for undocumented immigrants");
  });
});
