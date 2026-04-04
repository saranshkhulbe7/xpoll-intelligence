/**
 * Small text utilities.
 * This POC keeps normalization intentionally simple.
 */

export function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(value: string): string {
  return normalizeText(value).replace(/\s+/g, "_");
}
