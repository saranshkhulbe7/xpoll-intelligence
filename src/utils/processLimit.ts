export function parseProcessTillFirstNVotes(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized === "null") {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "PROCESS_TILL_FIRST_N_VOTES must be a positive integer or null.",
    );
  }

  return parsed;
}
