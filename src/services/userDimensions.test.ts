import { describe, expect, test } from "bun:test";
import { buildUserDimensions } from "./userDimensions";
import type { RawVote } from "../types";

function createVoter(overrides: Partial<RawVote["voter"]> = {}): RawVote["voter"] {
  return {
    externalAccountId: "user-1",
    username: "maya.sen",
    gender: "female",
    location: {
      city: "Mumbai",
      state: "Maharashtra",
      country: "India",
    },
    ...overrides,
  };
}

describe("buildUserDimensions", () => {
  test("builds stable shared location and gender dimensions", () => {
    const dimensions = buildUserDimensions(createVoter());

    expect(dimensions.country).toMatchObject({
      canonicalId: "country:india",
      name: "India",
      normalizedName: "india",
    });
    expect(dimensions.state).toMatchObject({
      canonicalId: "state:india__maharashtra",
      name: "Maharashtra",
      normalizedName: "maharashtra",
    });
    expect(dimensions.city).toMatchObject({
      canonicalId: "city:india:maharashtra:mumbai",
      name: "Mumbai",
      normalizedName: "mumbai",
    });
    expect(dimensions.gender).toMatchObject({
      canonicalId: "gender:female",
      name: "female",
      normalizedName: "female",
    });
  });

  test("handles partial location data without inventing missing hierarchy", () => {
    const dimensions = buildUserDimensions(createVoter({
      location: {
        city: null,
        state: "Texas",
        country: "USA",
      },
      gender: null,
    }));

    expect(dimensions.city).toBeUndefined();
    expect(dimensions.state?.canonicalId).toBe("state:usa__texas");
    expect(dimensions.country?.canonicalId).toBe("country:usa");
    expect(dimensions.gender).toBeUndefined();
  });
});
