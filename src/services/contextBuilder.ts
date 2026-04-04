import { createHash } from "node:crypto";
import type { RawVote } from "../types";

export function getSelectedOption(vote: RawVote): string | null {
  const selected = vote.poll.options.find((option) => option.isSelected);
  return selected?.text ?? null;
}

/**
 * Builds one compact text block that represents the full context of one vote.
 * This is what a real LLM would read later.
 */
export function buildVoteContext(vote: RawVote): string {
  const selectedOption = getSelectedOption(vote) ?? "UNKNOWN";
  const otherOptions = vote.poll.options.map((option) => option.text).join(", ");

  return [
    `Vote type: ${vote.type}`,
    `Poll title: ${vote.poll.title}`,
    `Poll description: ${vote.poll.description ?? ""}`,
    `Selected option: ${selectedOption}`,
    `All options: ${otherOptions}`,
    `Trial title: ${vote.trial?.title ?? ""}`,
    `Trial description: ${vote.trial?.description ?? ""}`,
    `Campaign name: ${vote.campaign?.name ?? ""}`,
    `Campaign goal: ${vote.campaign?.goal ?? ""}`,
    `InkD blog title: ${vote.inkdBlog?.title ?? ""}`,
    `InkD blog description: ${vote.inkdBlog?.description ?? ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPollTemplateContext(vote: RawVote): string {
  const options = vote.poll.options.map((option, index) => `Option ${index + 1}: ${option.text}`).join("\n");

  return [
    `Vote type: ${vote.type}`,
    `Poll id: ${vote.poll.pollId}`,
    `Poll title: ${vote.poll.title}`,
    `Poll description: ${vote.poll.description ?? ""}`,
    `Options:\n${options}`,
    `Trial title: ${vote.trial?.title ?? ""}`,
    `Trial description: ${vote.trial?.description ?? ""}`,
    `Campaign name: ${vote.campaign?.name ?? ""}`,
    `Campaign goal: ${vote.campaign?.goal ?? ""}`,
    `InkD blog title: ${vote.inkdBlog?.title ?? ""}`,
    `InkD blog description: ${vote.inkdBlog?.description ?? ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPollFingerprint(vote: RawVote): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        type: vote.type,
        pollId: vote.poll.pollId,
        title: vote.poll.title,
        description: vote.poll.description ?? null,
        options: vote.poll.options.map((option) => option.text),
        trial: vote.trial ?? null,
        campaign: vote.campaign ?? null,
        inkdBlog: vote.inkdBlog ?? null,
      }),
    )
    .digest("hex");
}

export function buildPollKey(vote: RawVote): string {
  return `poll:${vote.poll.pollId}`;
}
