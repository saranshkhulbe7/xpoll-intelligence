import { describe, expect, test } from "bun:test";
import {
  computeCurrentIntensity,
  decayIntensityMass,
  intensityBandToContribution,
  updateIntensityState,
} from "./intensity";

describe("intensityBandToContribution", () => {
  test("maps weak, medium, and strong bands to deterministic contributions", () => {
    expect(intensityBandToContribution("weak")).toBe(0.35);
    expect(intensityBandToContribution("medium")).toBe(0.60);
    expect(intensityBandToContribution("strong")).toBe(0.85);
  });
});

describe("decayIntensityMass", () => {
  test("halves the intensity mass over one half-life", () => {
    const decayed = decayIntensityMass({
      mass: 0.6,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-06-30T00:00:00.000Z",
      halfLifeDays: 180,
    });

    expect(decayed).toBeCloseTo(0.3, 3);
  });
});

describe("computeCurrentIntensity", () => {
  test("suppresses intensity using opposite mass while keeping the result in 0..1", () => {
    const intensity = computeCurrentIntensity({
      ownMass: 0.85,
      oppositeMass: 0.35,
      suppressionFactor: 0.7,
    });

    expect(intensity).toBeGreaterThan(0);
    expect(intensity).toBeLessThan(1);
  });
});

describe("updateIntensityState", () => {
  test("repeated same-direction evidence accumulates with diminishing returns", () => {
    const first = updateIntensityState({
      ownMass: 0,
      ownLastDecayAt: null,
      oppositeMass: 0,
      oppositeLastDecayAt: null,
      eventAt: "2026-01-01T00:00:00.000Z",
      baseContribution: 0.6,
      halfLifeDays: 180,
      suppressionFactor: 0.7,
    });
    const second = updateIntensityState({
      ownMass: first.ownMass,
      ownLastDecayAt: "2026-01-01T00:00:00.000Z",
      oppositeMass: first.oppositeMass,
      oppositeLastDecayAt: "2026-01-01T00:00:00.000Z",
      eventAt: "2026-01-31T00:00:00.000Z",
      baseContribution: 0.6,
      halfLifeDays: 180,
      suppressionFactor: 0.7,
    });

    expect(second.ownMass).toBeGreaterThan(first.ownMass);
    expect(second.ownIntensity).toBeGreaterThan(first.ownIntensity);
    expect(second.ownIntensity).toBeLessThan(1);
  });

  test("newer opposite evidence weakens the prior side while strengthening the new side", () => {
    const positive = updateIntensityState({
      ownMass: 0,
      ownLastDecayAt: null,
      oppositeMass: 0,
      oppositeLastDecayAt: null,
      eventAt: "2026-01-01T00:00:00.000Z",
      baseContribution: 0.85,
      halfLifeDays: 180,
      suppressionFactor: 0.7,
    });
    const negative = updateIntensityState({
      ownMass: 0,
      ownLastDecayAt: null,
      oppositeMass: positive.ownMass,
      oppositeLastDecayAt: "2026-01-01T00:00:00.000Z",
      eventAt: "2026-02-15T00:00:00.000Z",
      baseContribution: 0.85,
      halfLifeDays: 180,
      suppressionFactor: 0.7,
    });

    expect(negative.ownIntensity).toBeGreaterThan(0);
    expect(negative.oppositeIntensity).toBeLessThan(positive.ownIntensity);
  });
});
