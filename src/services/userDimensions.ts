import type { RawVote } from "../types";
import { normalizeText, slugify } from "../utils/text";

export type UserDimensionKind = "country" | "state" | "city" | "gender";

export type UserDimensionNode = {
  kind: UserDimensionKind;
  canonicalId: string;
  name: string;
  normalizedName: string;
};

export type UserDimensions = {
  country?: UserDimensionNode;
  state?: UserDimensionNode;
  city?: UserDimensionNode;
  gender?: UserDimensionNode;
};

function toCanonicalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildUserDimensions(voter: RawVote["voter"]): UserDimensions {
  const countryName = toCanonicalName(voter.location?.country);
  const stateName = toCanonicalName(voter.location?.state);
  const cityName = toCanonicalName(voter.location?.city);
  const genderName = toCanonicalName(voter.gender);

  const country = countryName
    ? {
        kind: "country" as const,
        canonicalId: `country:${slugify(countryName)}`,
        name: countryName,
        normalizedName: normalizeText(countryName),
      }
    : undefined;

  const state = stateName
    ? {
        kind: "state" as const,
        canonicalId: countryName
          ? `state:${slugify(countryName)}__${slugify(stateName)}`
          : `state:${slugify(stateName)}`,
        name: stateName,
        normalizedName: normalizeText(stateName),
      }
    : undefined;

  const city = cityName
    ? {
        kind: "city" as const,
        canonicalId: [
          "city",
          countryName ? slugify(countryName) : null,
          stateName ? slugify(stateName) : null,
          slugify(cityName),
        ].filter(Boolean).join(":").replace(/:/, ":"),
        name: cityName,
        normalizedName: normalizeText(cityName),
      }
    : undefined;

  const gender = genderName
    ? {
        kind: "gender" as const,
        canonicalId: `gender:${slugify(genderName)}`,
        name: genderName,
        normalizedName: normalizeText(genderName),
      }
    : undefined;

  return {
    country,
    state,
    city,
    gender,
  };
}
