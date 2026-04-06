import { normalizeText } from "./text";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "of",
  "and",
  "in",
  "on",
  "with",
  "without",
  "after",
  "before",
  "who",
  "that",
  "this",
  "these",
  "those",
  "us",
  "u",
  "s",
]);

const ENTITY_CONTEXT_KEYWORDS = new Set([
  "impact",
  "influence",
  "leadership",
  "policy",
  "debate",
  "direction",
  "agenda",
  "reform",
  "issue",
  "stance",
  "view",
  "views",
]);

const ENTITY_ALIAS_DISALLOWED_PREFIXES = [
  /^(has|have|had|did|does|do|should|would|could|will|can|is|are|was|were)\b/i,
  /^(he|she|they|his|her|their)\b/i,
  /^(yes|no)\b[:,]?\s*/i,
];

export function meaningfulTokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function lexicalOverlapRatio(left: string, right: string): number {
  const leftTokens = Array.from(new Set(meaningfulTokens(left)));
  const rightTokens = Array.from(new Set(meaningfulTokens(right)));

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightTokenSet = new Set(rightTokens);
  const overlapCount = leftTokens.filter((token) => rightTokenSet.has(token)).length;
  return overlapCount / Math.min(leftTokens.length, rightTokens.length);
}

export function hasHighLexicalOverlap(left: string, right: string, threshold = 0.6): boolean {
  return lexicalOverlapRatio(left, right) >= threshold;
}

export function hasNameLikeOverlap(left: string, right: string): boolean {
  const leftTokens = Array.from(new Set(meaningfulTokens(left)));
  const rightTokens = Array.from(new Set(meaningfulTokens(right)));

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return false;
  }

  const rightTokenSet = new Set(rightTokens);
  const overlapCount = leftTokens.filter((token) => rightTokenSet.has(token)).length;
  return overlapCount / Math.min(leftTokens.length, rightTokens.length) >= 0.5;
}

export function isContextualEntityLabel(label: string): boolean {
  const normalized = normalizeText(label);
  const tokens = meaningfulTokens(label);

  if (tokens.length === 0) {
    return false;
  }

  if (/'s\b/i.test(label)) {
    return true;
  }

  if (tokens.length > 4) {
    return true;
  }

  return tokens.some((token) => ENTITY_CONTEXT_KEYWORDS.has(token));
}

export function extractLikelyEntityName(value: string): string | undefined {
  const matches = value.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g) ?? [];

  for (const match of matches) {
    const normalized = normalizeText(match);
    if (normalized !== "united states") {
      return match.trim();
    }
  }

  return undefined;
}

export function stripOptionLeadIn(value: string): string {
  return value
    .replace(/^(yes|no)\b[:,]?\s*/i, "")
    .replace(/\b(definitely|absolutely|clearly|really|strongly)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isValidEntityAlias(alias: string, canonicalEntityLabel: string): boolean {
  const trimmed = alias.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.includes("?")) {
    return false;
  }

  if (ENTITY_ALIAS_DISALLOWED_PREFIXES.some((pattern) => pattern.test(trimmed))) {
    return false;
  }

  return hasNameLikeOverlap(trimmed, canonicalEntityLabel);
}

export function filterEntityAliases(canonicalEntityLabel: string, aliases: string[]): string[] {
  const deduped = Array.from(new Set([canonicalEntityLabel, ...aliases].map((value) => value.trim()).filter(Boolean)));
  return deduped.filter((alias) => isValidEntityAlias(alias, canonicalEntityLabel));
}
