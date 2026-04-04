import type { IntensityBand } from "../types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const INTENSITY_CONTRIBUTION_BY_BAND: Record<IntensityBand, number> = {
  weak: 0.35,
  medium: 0.60,
  strong: 0.85,
};

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function intensityBandToContribution(band: IntensityBand): number {
  return INTENSITY_CONTRIBUTION_BY_BAND[band];
}

export function decayIntensityMass(args: {
  mass: number;
  from: string | null | undefined;
  to: string | null | undefined;
  halfLifeDays: number;
}): number {
  const safeMass = Math.max(0, args.mass);
  const fromMs = parseTimestamp(args.from);
  const toMs = parseTimestamp(args.to);

  if (safeMass === 0 || fromMs === null || toMs === null || toMs <= fromMs || args.halfLifeDays <= 0) {
    return safeMass;
  }

  const lambda = Math.log(2) / (args.halfLifeDays * MS_PER_DAY);
  return safeMass * Math.exp(-lambda * (toMs - fromMs));
}

export function computeCurrentIntensity(args: {
  ownMass: number;
  oppositeMass: number;
  suppressionFactor: number;
}): number {
  const effectiveMass = Math.max(0, args.ownMass - args.suppressionFactor * args.oppositeMass);
  return clamp01(1 - Math.exp(-effectiveMass));
}

export function updateIntensityState(args: {
  ownMass: number;
  ownLastDecayAt: string | null | undefined;
  oppositeMass: number;
  oppositeLastDecayAt: string | null | undefined;
  eventAt: string;
  baseContribution: number;
  halfLifeDays: number;
  suppressionFactor: number;
}): {
  ownMass: number;
  ownIntensity: number;
  oppositeMass: number;
  oppositeIntensity: number;
} {
  const ownDecayedMass = decayIntensityMass({
    mass: args.ownMass,
    from: args.ownLastDecayAt,
    to: args.eventAt,
    halfLifeDays: args.halfLifeDays,
  });
  const oppositeDecayedMass = decayIntensityMass({
    mass: args.oppositeMass,
    from: args.oppositeLastDecayAt,
    to: args.eventAt,
    halfLifeDays: args.halfLifeDays,
  });
  const updatedOwnMass = Math.max(0, ownDecayedMass + Math.max(0, args.baseContribution));
  const updatedOppositeMass = Math.max(0, oppositeDecayedMass);

  return {
    ownMass: updatedOwnMass,
    ownIntensity: computeCurrentIntensity({
      ownMass: updatedOwnMass,
      oppositeMass: updatedOppositeMass,
      suppressionFactor: args.suppressionFactor,
    }),
    oppositeMass: updatedOppositeMass,
    oppositeIntensity: computeCurrentIntensity({
      ownMass: updatedOppositeMass,
      oppositeMass: updatedOwnMass,
      suppressionFactor: args.suppressionFactor,
    }),
  };
}
