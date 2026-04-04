import type { RawVote, VoteItemType } from "../types";

type BenchmarkPersona = "progressive" | "conservative" | "moderate" | "libertarian";

type BenchmarkVoter = {
  externalAccountId: string;
  username: string;
  googleEmail: string;
  gender: "female" | "male" | "nonbinary";
  dob: string;
  civicScore: number;
  level: number;
  location: {
    city: string;
    state: string;
    country: string;
  };
  persona: BenchmarkPersona;
};

type BenchmarkOptionExpectation = {
  optionIndex: 0 | 1 | 2;
  plainEnglishMeaning: string;
  semanticIntent: string;
  stanceKeywords: string[];
  ideologyHint?: string;
  entitySentiment?: "positive" | "negative" | "neutral";
};

type BenchmarkTrial = {
  trialId: string;
  title: string;
  description: string;
  createdAt: string;
};

type BenchmarkCampaign = {
  campaignId: string;
  name: string;
  goal: string;
  isPolitical: boolean;
  createdAt: string;
};

type BenchmarkPollDefinition = {
  pollId: string;
  type: VoteItemType;
  title: string;
  description: string;
  options: [string, string, string];
  topicKeywords: string[];
  personaSelections: Record<BenchmarkPersona, BenchmarkOptionExpectation>;
  entity?: string;
  trial?: BenchmarkTrial;
  campaign?: BenchmarkCampaign;
};

export type PoliticalBenchmarkRelationshipExpectation = {
  from: "User" | "Assertion";
  type: string;
  to: "Assertion" | "Topic" | "Position" | "Entity";
};

export type PoliticalBenchmarkVoteExpectation = {
  voteId: string;
  pollId: string;
  voteType: VoteItemType;
  voterExternalAccountId: string;
  voterPersona: BenchmarkPersona;
  selectedOption: string;
  plainEnglishMeaning: string;
  expectedSemanticIntent: string;
  expectedTopicKeywords: string[];
  expectedTargetKeywords: string[];
  expectedEntity?: string;
  expectedEntitySentiment?: "positive" | "negative" | "neutral";
  expectedIdeologyHint?: string;
  expectedGraphRelationships: PoliticalBenchmarkRelationshipExpectation[];
};

export type PoliticalBenchmarkManifest = {
  datasetName: string;
  description: string;
  generatedAt: string;
  aggregateExpectations: {
    expectedVoteCount: number;
    expectedUserCount: number;
    expectedPollCount: number;
    expectedTrialNodeCount: number;
    expectedCampaignNodeCount: number;
    expectedPollTypeCounts: Record<VoteItemType, number>;
    expectedVoteTypeCounts: Record<VoteItemType, number>;
  };
  personaExpectations: Array<{
    persona: BenchmarkPersona;
    userCount: number;
    expectedVoteCount: number;
    commonTargetKeywords: string[];
    commonIdeologyKeywords: string[];
    summary: string;
  }>;
  voteExpectations: PoliticalBenchmarkVoteExpectation[];
};

export const POLITICAL_BENCHMARK_DATASET_NAME = "political-benchmark-100";
export const POLITICAL_BENCHMARK_DATA_FILE = "political-benchmark-100.json";
export const POLITICAL_BENCHMARK_EXPECTED_FILE = "political-benchmark-100.expected.json";

function isoDate(dayOfMonth: number, hour: number, minute: number): string {
  return new Date(Date.UTC(2026, 0, dayOfMonth, hour, minute, 0)).toISOString();
}

function createVoter(args: {
  id: number;
  username: string;
  persona: BenchmarkPersona;
  gender: "female" | "male" | "nonbinary";
  city: string;
  state: string;
  country: string;
}): BenchmarkVoter {
  const birthYear = 1983 + (args.id % 14);
  const birthMonth = args.id % 12;
  const birthDay = (args.id % 27) + 1;

  return {
    externalAccountId: `bench-user-${String(args.id).padStart(3, "0")}`,
    username: args.username,
    googleEmail: `${args.username.replace(/\./g, "")}@benchmark.local`,
    gender: args.gender,
    dob: new Date(Date.UTC(birthYear, birthMonth, birthDay, 0, 0, 0)).toISOString(),
    civicScore: 700 + args.id * 12,
    level: (args.id % 5) + 1,
    location: {
      city: args.city,
      state: args.state,
      country: args.country,
    },
    persona: args.persona,
  };
}

function selection(
  optionIndex: 0 | 1 | 2,
  plainEnglishMeaning: string,
  semanticIntent: string,
  stanceKeywords: string[],
  extras: {
    ideologyHint?: string;
    entitySentiment?: "positive" | "negative" | "neutral";
  } = {},
): BenchmarkOptionExpectation {
  return {
    optionIndex,
    plainEnglishMeaning,
    semanticIntent,
    stanceKeywords,
    ideologyHint: extras.ideologyHint,
    entitySentiment: extras.entitySentiment,
  };
}

function buildTrial(index: number, title: string, description: string): BenchmarkTrial {
  return {
    trialId: `bench-trial-${String(index).padStart(3, "0")}`,
    title,
    description,
    createdAt: isoDate(18 + index, 8, 15),
  };
}

function buildCampaign(index: number, name: string, goal: string): BenchmarkCampaign {
  return {
    campaignId: `bench-campaign-${String(index).padStart(3, "0")}`,
    name,
    goal,
    isPolitical: true,
    createdAt: isoDate(24 + index, 9, 30),
  };
}

const progressiveVoters: BenchmarkVoter[] = [
  createVoter({ id: 1, username: "maya.sen", persona: "progressive", gender: "female", city: "Mumbai", state: "Maharashtra", country: "India" }),
  createVoter({ id: 2, username: "arjun.patel", persona: "progressive", gender: "male", city: "Bengaluru", state: "Karnataka", country: "India" }),
  createVoter({ id: 3, username: "nina.hart", persona: "progressive", gender: "female", city: "Seattle", state: "Washington", country: "USA" }),
  createVoter({ id: 4, username: "leah.cohen", persona: "progressive", gender: "female", city: "London", state: "England", country: "UK" }),
  createVoter({ id: 5, username: "omar.khan", persona: "progressive", gender: "male", city: "Toronto", state: "Ontario", country: "Canada" }),
];

const conservativeVoters: BenchmarkVoter[] = [
  createVoter({ id: 6, username: "ethan.clark", persona: "conservative", gender: "male", city: "Dallas", state: "Texas", country: "USA" }),
  createVoter({ id: 7, username: "priyank.sharma", persona: "conservative", gender: "male", city: "Jaipur", state: "Rajasthan", country: "India" }),
  createVoter({ id: 8, username: "grace.miller", persona: "conservative", gender: "female", city: "Nashville", state: "Tennessee", country: "USA" }),
  createVoter({ id: 9, username: "rohan.malhotra", persona: "conservative", gender: "male", city: "New Delhi", state: "Delhi", country: "India" }),
  createVoter({ id: 10, username: "hannah.brooks", persona: "conservative", gender: "female", city: "Phoenix", state: "Arizona", country: "USA" }),
];

const moderateVoters: BenchmarkVoter[] = [
  createVoter({ id: 11, username: "aditi.rao", persona: "moderate", gender: "female", city: "Pune", state: "Maharashtra", country: "India" }),
  createVoter({ id: 12, username: "daniel.lee", persona: "moderate", gender: "male", city: "San Jose", state: "California", country: "USA" }),
  createVoter({ id: 13, username: "sara.williams", persona: "moderate", gender: "female", city: "Sydney", state: "NSW", country: "Australia" }),
  createVoter({ id: 14, username: "vikram.joshi", persona: "moderate", gender: "male", city: "Hyderabad", state: "Telangana", country: "India" }),
  createVoter({ id: 15, username: "emma.collins", persona: "moderate", gender: "female", city: "Manchester", state: "England", country: "UK" }),
];

const libertarianVoters: BenchmarkVoter[] = [
  createVoter({ id: 16, username: "neil.russell", persona: "libertarian", gender: "male", city: "Austin", state: "Texas", country: "USA" }),
  createVoter({ id: 17, username: "kavin.iyer", persona: "libertarian", gender: "male", city: "Chennai", state: "Tamil Nadu", country: "India" }),
  createVoter({ id: 18, username: "jake.turner", persona: "libertarian", gender: "male", city: "Denver", state: "Colorado", country: "USA" }),
  createVoter({ id: 19, username: "meera.sahni", persona: "libertarian", gender: "female", city: "Gurgaon", state: "Haryana", country: "India" }),
  createVoter({ id: 20, username: "chloe.parker", persona: "libertarian", gender: "female", city: "Wellington", state: "Wellington", country: "New Zealand" }),
];

const voterGroups: BenchmarkVoter[][] = [
  [progressiveVoters[0], conservativeVoters[0], moderateVoters[0], libertarianVoters[0], progressiveVoters[1]],
  [progressiveVoters[2], conservativeVoters[1], moderateVoters[1], libertarianVoters[1], conservativeVoters[2]],
  [progressiveVoters[3], conservativeVoters[3], moderateVoters[2], libertarianVoters[2], moderateVoters[3]],
  [progressiveVoters[4], conservativeVoters[4], moderateVoters[4], libertarianVoters[3], libertarianVoters[4]],
];

const benchmarkPolls: BenchmarkPollDefinition[] = [
  {
    pollId: "bench-poll-001",
    type: "standalone_poll",
    title: "Should undocumented immigrants who pass background checks get a path to citizenship?",
    description: "A clear immigration vote about legal status, border enforcement, and long-term inclusion.",
    options: [
      "Offer a path to citizenship after background checks",
      "Allow temporary work permits but not citizenship",
      "Reject any pathway and prioritize deportation",
    ],
    topicKeywords: ["immigration", "pathway to citizenship", "legal status"],
    personaSelections: {
      progressive: selection(0, "supports a background-check-based path to citizenship", "backs legal inclusion for undocumented immigrants who meet security checks", ["path to citizenship", "legalization", "inclusion"], { ideologyHint: "progressive" }),
      conservative: selection(2, "opposes legal status and prefers deportation-first enforcement", "backs hardline immigration enforcement over legalization", ["deportation", "border enforcement", "no pathway"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports a limited compromise with work permits but no citizenship", "backs a partial immigration compromise short of citizenship", ["temporary permits", "compromise", "limited legalization"], { ideologyHint: "moderate" }),
      libertarian: selection(1, "supports a limited legal status compromise without a full citizenship promise", "backs a narrower legal-status compromise rather than deportation or full citizenship", ["temporary permits", "limited status", "compromise"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-002",
    type: "standalone_poll",
    title: "Should the government create a national public health insurance plan?",
    description: "A clean healthcare policy vote contrasting public insurance, a mixed system, and market-led coverage.",
    options: [
      "Create a national public health insurance plan",
      "Keep a mixed public-private system with targeted fixes",
      "Rely more on private insurance and market competition",
    ],
    topicKeywords: ["healthcare", "public insurance", "health system"],
    personaSelections: {
      progressive: selection(0, "supports a national public insurance plan", "backs a stronger public role in healthcare coverage", ["public insurance", "universal coverage", "government plan"], { ideologyHint: "progressive" }),
      conservative: selection(2, "prefers private insurance and competition", "backs a market-led healthcare system over public expansion", ["private insurance", "market competition", "limited government"], { ideologyHint: "conservative" }),
      moderate: selection(1, "prefers pragmatic fixes to the current mixed system", "backs incremental healthcare reform rather than a full overhaul", ["mixed system", "targeted fixes", "incremental reform"], { ideologyHint: "moderate" }),
      libertarian: selection(2, "prefers private insurance and competition", "backs market-based healthcare over national insurance", ["private insurance", "market competition", "small government"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-003",
    type: "standalone_poll",
    title: "Should taxes go up on households earning over $1 million?",
    description: "A high-income tax policy vote with three very distinct positions.",
    options: [
      "Raise taxes on households earning over $1 million",
      "Keep current high-income tax rates",
      "Lower taxes to spur investment and growth",
    ],
    topicKeywords: ["taxation", "high-income taxes", "economic policy"],
    personaSelections: {
      progressive: selection(0, "supports higher taxes on millionaires", "backs more progressive taxation on top earners", ["raise taxes", "millionaires", "redistribution"], { ideologyHint: "progressive" }),
      conservative: selection(2, "supports lower taxes to encourage growth", "backs tax cuts and supply-side growth arguments", ["lower taxes", "investment", "growth"], { ideologyHint: "conservative" }),
      moderate: selection(1, "prefers keeping current tax rates", "backs a status-quo tax position on high earners", ["current rates", "status quo", "tax stability"], { ideologyHint: "moderate" }),
      libertarian: selection(2, "supports lower taxes to encourage growth", "backs tax cuts and reduced state extraction", ["lower taxes", "investment", "small government"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-004",
    type: "standalone_poll",
    title: "Should government invest heavily in renewable energy even if bills rise in the short term?",
    description: "A climate and energy transition vote contrasting public investment, balance, and cost avoidance.",
    options: [
      "Invest heavily in renewable energy even with short-term costs",
      "Balance renewables with existing energy sources",
      "Avoid extra climate spending that raises bills",
    ],
    topicKeywords: ["climate", "renewable energy", "energy transition"],
    personaSelections: {
      progressive: selection(0, "supports major renewable investment despite short-term costs", "backs aggressive public climate investment", ["renewables", "climate investment", "energy transition"], { ideologyHint: "progressive" }),
      conservative: selection(2, "opposes extra climate spending that raises bills", "backs cost-focused resistance to aggressive climate spending", ["energy costs", "oppose climate spending", "consumer bills"], { ideologyHint: "conservative" }),
      moderate: selection(1, "prefers a balanced energy transition", "backs a gradual energy transition that keeps current fuels in the mix", ["balanced transition", "existing fuels", "pragmatic climate policy"], { ideologyHint: "moderate" }),
      libertarian: selection(2, "opposes extra climate spending that raises bills", "backs limiting government-led climate spending", ["energy costs", "government spending", "market choice"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-005",
    type: "standalone_poll",
    title: "Should universal background checks apply to all gun sales?",
    description: "A gun policy vote with a clear reform option, an enforcement-first middle position, and a rights-first option.",
    options: [
      "Require universal background checks for all gun sales",
      "Improve enforcement of current gun laws first",
      "Protect private sales from new gun restrictions",
    ],
    topicKeywords: ["gun policy", "background checks", "firearms regulation"],
    personaSelections: {
      progressive: selection(0, "supports universal background checks", "backs stronger gun-sale screening requirements", ["background checks", "gun safety", "new regulation"], { ideologyHint: "progressive" }),
      conservative: selection(1, "prefers enforcing existing laws before adding new rules", "backs a law-and-order middle position on gun policy", ["enforce current laws", "no new restrictions", "existing law"], { ideologyHint: "conservative" }),
      moderate: selection(1, "prefers enforcing existing laws before adding new rules", "backs a moderate enforcement-first gun policy", ["enforce current laws", "incremental change", "moderate gun policy"], { ideologyHint: "moderate" }),
      libertarian: selection(2, "opposes new restrictions on private gun sales", "backs broader gun rights and fewer new regulations", ["private sales", "gun rights", "anti-restriction"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-006",
    type: "standalone_poll",
    title: "Should abortion access be protected nationwide?",
    description: "A reproductive-rights vote with explicit rights, compromise, and ban options.",
    options: [
      "Protect abortion access nationwide",
      "Leave access legal but allow some limits",
      "Ban abortion except in narrow cases",
    ],
    topicKeywords: ["abortion", "reproductive rights", "bodily autonomy"],
    personaSelections: {
      progressive: selection(0, "supports nationwide abortion access", "backs protecting abortion rights nationally", ["abortion access", "reproductive rights", "national protection"], { ideologyHint: "progressive" }),
      conservative: selection(2, "supports a near-total abortion ban", "backs strong abortion restrictions", ["abortion ban", "pro-life", "narrow exceptions"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports legal access with some limits", "backs a compromise abortion policy with restrictions", ["legal with limits", "compromise", "restricted access"], { ideologyHint: "moderate" }),
      libertarian: selection(0, "supports abortion access on bodily-autonomy grounds", "backs abortion access as a civil-liberty issue", ["abortion access", "bodily autonomy", "civil liberty"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-007",
    type: "standalone_poll",
    title: "Should the federal minimum wage be raised to a living wage?",
    description: "A labor-policy vote that contrasts strong labor standards, smaller compromise increases, and state or market control.",
    options: [
      "Raise the federal minimum wage to a living wage",
      "Adopt a smaller regional minimum wage increase",
      "Leave wage setting mostly to employers and states",
    ],
    topicKeywords: ["jobs", "labor", "minimum wage"],
    personaSelections: {
      progressive: selection(0, "supports a larger federal minimum wage increase", "backs a stronger wage floor for workers", ["minimum wage increase", "living wage", "worker support"], { ideologyHint: "progressive" }),
      conservative: selection(2, "prefers employers and states to set wages", "backs less federal intervention in wage policy", ["state control", "employer flexibility", "less federal role"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports a smaller regional increase", "backs a calibrated minimum wage compromise", ["regional increase", "incremental wage change", "compromise"], { ideologyHint: "moderate" }),
      libertarian: selection(2, "prefers wages to be set by employers and local governments", "backs market-led wage setting over federal mandates", ["employer choice", "market wages", "anti-mandate"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-008",
    type: "standalone_poll",
    title: "Should cities legalize denser housing near transit and job centers?",
    description: "A housing vote about zoning reform, gradualism, and neighborhood protection.",
    options: [
      "Legalize denser housing near transit and job centers",
      "Allow gradual upzoning with local review",
      "Protect single-family zoning from state overrides",
    ],
    topicKeywords: ["housing", "zoning", "density"],
    personaSelections: {
      progressive: selection(0, "supports denser housing near transit", "backs zoning reform to expand housing supply", ["denser housing", "upzoning", "housing supply"], { ideologyHint: "progressive" }),
      conservative: selection(2, "supports preserving single-family zoning", "backs local control and neighborhood preservation over state-led upzoning", ["single-family zoning", "local control", "anti-upzoning"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports gradual upzoning with local review", "backs incremental zoning reform", ["gradual upzoning", "local review", "incremental reform"], { ideologyHint: "moderate" }),
      libertarian: selection(0, "supports broader housing deregulation", "backs reducing zoning barriers to let more housing be built", ["housing deregulation", "upzoning", "more supply"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-009",
    type: "standalone_poll",
    title: "Should the U.S. continue strong military aid to Ukraine?",
    description: "A foreign-policy vote about alliance support, diplomacy, and pulling back from overseas commitments.",
    options: [
      "Continue strong military aid to Ukraine",
      "Continue aid while pushing harder for diplomacy",
      "Reduce aid and focus more on domestic priorities",
    ],
    topicKeywords: ["foreign policy", "Ukraine", "military aid"],
    personaSelections: {
      progressive: selection(0, "supports continued military aid to Ukraine", "backs strong support for Ukraine against aggression", ["Ukraine aid", "alliance support", "defense assistance"], { ideologyHint: "progressive" }),
      conservative: selection(2, "prefers reducing aid and focusing at home", "backs a more inward-looking foreign policy", ["reduce aid", "domestic priorities", "less overseas commitment"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports aid with a stronger diplomatic push", "backs a mixed security-and-diplomacy approach", ["aid plus diplomacy", "burden sharing", "measured support"], { ideologyHint: "moderate" }),
      libertarian: selection(2, "prefers reducing aid and focusing at home", "backs limiting foreign commitments and prioritizing domestic concerns", ["reduce aid", "anti-intervention", "domestic priorities"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-010",
    type: "standalone_poll",
    title: "Should mandatory minimum sentences be reduced for nonviolent offenses?",
    description: "A criminal-justice vote about sentencing reform, limited reform, and tough-on-crime policy.",
    options: [
      "Reduce mandatory minimums for nonviolent offenses",
      "Reform a few cases but keep most sentencing rules",
      "Keep tough mandatory minimum sentencing",
    ],
    topicKeywords: ["criminal justice", "sentencing reform", "mandatory minimums"],
    personaSelections: {
      progressive: selection(0, "supports reducing mandatory minimum sentences", "backs sentencing reform for nonviolent offenses", ["reduce sentences", "justice reform", "nonviolent offenses"], { ideologyHint: "progressive" }),
      conservative: selection(2, "supports keeping tough sentencing rules", "backs a tougher law-and-order sentencing stance", ["tough sentencing", "law and order", "mandatory minimums"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports targeted sentencing reform only", "backs limited criminal-justice reform", ["targeted reform", "limited change", "measured sentencing reform"], { ideologyHint: "moderate" }),
      libertarian: selection(0, "supports reducing mandatory minimum sentences", "backs reducing state punishment for nonviolent offenses", ["reduce sentences", "overcriminalization", "civil liberty"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-011",
    type: "standalone_poll",
    title: "Did Bernie Sanders push the healthcare debate in a helpful direction?",
    description: "An actor-specific healthcare poll designed to surface an entity and sentiment.",
    options: [
      "Yes, he pushed healthcare in a helpful direction",
      "He raised useful issues but went too far",
      "No, his approach pushed healthcare the wrong way",
    ],
    topicKeywords: ["healthcare debate", "political leadership", "public healthcare"],
    entity: "Bernie Sanders",
    personaSelections: {
      progressive: selection(0, "views Bernie Sanders as helpful on healthcare", "expresses positive sentiment toward Bernie Sanders on healthcare", ["helpful healthcare leadership", "public healthcare advocacy", "positive view"], { ideologyHint: "progressive", entitySentiment: "positive" }),
      conservative: selection(2, "views Bernie Sanders as harmful on healthcare", "expresses negative sentiment toward Bernie Sanders on healthcare", ["wrong direction", "negative view", "healthcare opposition"], { ideologyHint: "conservative", entitySentiment: "negative" }),
      moderate: selection(1, "thinks Bernie Sanders raised real issues but overreached", "expresses mixed or neutral sentiment toward Bernie Sanders on healthcare", ["mixed results", "too far", "useful issues"], { ideologyHint: "moderate", entitySentiment: "neutral" }),
      libertarian: selection(2, "views Bernie Sanders as harmful on healthcare", "expresses negative sentiment toward Bernie Sanders on healthcare", ["wrong direction", "negative view", "state overreach"], { ideologyHint: "libertarian", entitySentiment: "negative" }),
    },
  },
  {
    pollId: "bench-poll-012",
    type: "standalone_poll",
    title: "Has Joe Biden moved U.S. climate policy in the right direction?",
    description: "An actor-specific climate poll designed to surface both topic and entity sentiment.",
    options: [
      "Yes, he has made strong climate progress",
      "He has made some progress but not enough",
      "No, he has moved climate policy in the wrong direction",
    ],
    topicKeywords: ["climate leadership", "U.S. climate policy", "energy transition"],
    entity: "Joe Biden",
    personaSelections: {
      progressive: selection(0, "views Joe Biden positively on climate policy", "expresses positive sentiment toward Joe Biden's climate direction", ["strong progress", "climate leadership", "positive view"], { ideologyHint: "progressive", entitySentiment: "positive" }),
      conservative: selection(2, "views Joe Biden negatively on climate policy", "expresses negative sentiment toward Joe Biden's climate direction", ["wrong direction", "negative view", "climate skepticism"], { ideologyHint: "conservative", entitySentiment: "negative" }),
      moderate: selection(1, "sees some climate progress under Joe Biden but wants more", "expresses a mixed or neutral sentiment toward Joe Biden on climate", ["some progress", "not enough", "mixed view"], { ideologyHint: "moderate", entitySentiment: "neutral" }),
      libertarian: selection(2, "views Joe Biden negatively on climate policy", "expresses negative sentiment toward Joe Biden's climate direction", ["wrong direction", "negative view", "too much government"], { ideologyHint: "libertarian", entitySentiment: "negative" }),
    },
  },
  {
    pollId: "bench-poll-013",
    type: "trial_poll",
    title: "Did Donald Trump's tax policy help the middle class?",
    description: "An actor-specific trial poll for testing tax-policy sentiment toward a political leader.",
    options: [
      "Yes, it mostly helped the middle class",
      "It had mixed results",
      "No, it mostly helped wealthy people",
    ],
    topicKeywords: ["tax policy", "middle class", "political leadership"],
    entity: "Donald Trump",
    trial: buildTrial(1, "Middle Class Tax Perception Trial", "Trial benchmark for actor-specific tax-policy sentiment."),
    personaSelections: {
      progressive: selection(2, "views Donald Trump's tax policy negatively", "expresses negative sentiment toward Donald Trump's tax policy", ["helped wealthy people", "negative view", "tax inequality"], { ideologyHint: "progressive", entitySentiment: "negative" }),
      conservative: selection(0, "views Donald Trump's tax policy positively", "expresses positive sentiment toward Donald Trump's tax policy", ["helped middle class", "tax cuts", "positive view"], { ideologyHint: "conservative", entitySentiment: "positive" }),
      moderate: selection(1, "thinks Donald Trump's tax policy had mixed results", "expresses a mixed or neutral sentiment toward Donald Trump's tax policy", ["mixed results", "neutral view", "tax tradeoffs"], { ideologyHint: "moderate", entitySentiment: "neutral" }),
      libertarian: selection(0, "views Donald Trump's tax policy positively", "expresses positive sentiment toward Donald Trump's tax policy", ["helped middle class", "tax cuts", "lower taxes"], { ideologyHint: "libertarian", entitySentiment: "positive" }),
    },
  },
  {
    pollId: "bench-poll-014",
    type: "trial_poll",
    title: "Has Joe Biden handled the southern border effectively?",
    description: "An immigration and border-management trial poll with explicit sentiment toward Joe Biden.",
    options: [
      "Yes, his border leadership has been effective",
      "He has had mixed results with clear problems",
      "No, the border response has failed",
    ],
    topicKeywords: ["immigration", "border policy", "executive leadership"],
    entity: "Joe Biden",
    trial: buildTrial(2, "Border Leadership Trial", "Trial benchmark for evaluating entity sentiment on immigration management."),
    personaSelections: {
      progressive: selection(1, "sees Joe Biden's border record as mixed", "expresses neutral sentiment toward Joe Biden on border management", ["mixed results", "border problems", "neutral view"], { ideologyHint: "progressive", entitySentiment: "neutral" }),
      conservative: selection(2, "views Joe Biden negatively on the border", "expresses negative sentiment toward Joe Biden's border handling", ["border failure", "negative view", "immigration criticism"], { ideologyHint: "conservative", entitySentiment: "negative" }),
      moderate: selection(1, "sees Joe Biden's border record as mixed", "expresses neutral sentiment toward Joe Biden on border management", ["mixed results", "border problems", "neutral view"], { ideologyHint: "moderate", entitySentiment: "neutral" }),
      libertarian: selection(2, "views Joe Biden negatively on the border", "expresses negative sentiment toward Joe Biden's border handling", ["border failure", "negative view", "executive criticism"], { ideologyHint: "libertarian", entitySentiment: "negative" }),
    },
  },
  {
    pollId: "bench-poll-015",
    type: "trial_poll",
    title: "Should cities fast-track affordable housing projects even when local residents object?",
    description: "A housing trial poll that contrasts rapid approval, case-by-case review, and strong local control.",
    options: [
      "Yes, fast-track affordable housing approvals",
      "Use case-by-case review before approving projects",
      "No, preserve local control over approvals",
    ],
    topicKeywords: ["housing", "affordable housing", "local control"],
    trial: buildTrial(3, "Affordable Housing Approval Trial", "Trial benchmark for housing approval and local-control tradeoffs."),
    personaSelections: {
      progressive: selection(0, "supports fast-tracking affordable housing", "backs aggressive approval of affordable housing projects", ["fast-track housing", "affordable housing", "pro-development"], { ideologyHint: "progressive" }),
      conservative: selection(2, "supports preserving local control over housing approvals", "backs local control over fast-tracked housing approvals", ["local control", "housing approvals", "anti-fast-track"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports case-by-case review of housing projects", "backs a middle-ground housing approval process", ["case-by-case review", "housing compromise", "balanced development"], { ideologyHint: "moderate" }),
      libertarian: selection(0, "supports fast-tracking housing to reduce barriers", "backs reducing procedural barriers to building housing", ["fast-track housing", "reduce barriers", "housing deregulation"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-016",
    type: "trial_poll",
    title: "Should government subsidize domestic semiconductor manufacturing?",
    description: "A jobs and industrial-policy trial poll contrasting heavy support, limited incentives, and market-first views.",
    options: [
      "Yes, make it a strategic national investment",
      "Use smaller temporary incentives only",
      "No, let the market decide",
    ],
    topicKeywords: ["jobs", "industrial policy", "semiconductors"],
    trial: buildTrial(4, "Semiconductor Industrial Policy Trial", "Trial benchmark for domestic manufacturing and industrial policy."),
    personaSelections: {
      progressive: selection(0, "supports strong subsidies for domestic chip production", "backs industrial policy and domestic manufacturing investment", ["strategic investment", "domestic manufacturing", "industrial policy"], { ideologyHint: "progressive" }),
      conservative: selection(0, "supports strong subsidies for strategic manufacturing", "backs national-interest subsidies for chip production", ["strategic investment", "national industry", "manufacturing"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports limited temporary incentives", "backs a narrower industrial-policy compromise", ["temporary incentives", "limited subsidies", "measured industrial policy"], { ideologyHint: "moderate" }),
      libertarian: selection(2, "opposes subsidies and prefers market allocation", "backs market-led investment over industrial subsidies", ["market decides", "anti-subsidy", "small government"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-017",
    type: "trial_poll",
    title: "Should police departments be required to use body cameras nationwide?",
    description: "A policing trial poll that contrasts a national accountability rule, local encouragement, and anti-mandate skepticism.",
    options: [
      "Yes, require body cameras nationwide",
      "Encourage local adoption without a federal mandate",
      "No, avoid a new national police requirement",
    ],
    topicKeywords: ["policing", "body cameras", "accountability"],
    trial: buildTrial(5, "Police Accountability Trial", "Trial benchmark for policing accountability and federal mandate questions."),
    personaSelections: {
      progressive: selection(0, "supports a nationwide body-camera requirement", "backs a stronger national police-accountability rule", ["body cameras", "police accountability", "national requirement"], { ideologyHint: "progressive" }),
      conservative: selection(1, "supports local adoption without a federal mandate", "backs accountability tools without a national mandate", ["local adoption", "no federal mandate", "incremental accountability"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports local adoption without a federal mandate", "backs a middle-ground police-accountability approach", ["local adoption", "incremental accountability", "moderate reform"], { ideologyHint: "moderate" }),
      libertarian: selection(0, "supports body cameras as an accountability tool", "backs body cameras to constrain state power and improve accountability", ["body cameras", "accountability", "civil liberties"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-018",
    type: "campaign_poll",
    title: "Should the U.S. keep a strong NATO commitment even when allies spend less?",
    description: "A campaign-linked foreign-policy poll about alliances, burden sharing, and retrenchment.",
    options: [
      "Keep a strong NATO commitment",
      "Stay in NATO but demand more burden sharing",
      "Scale back U.S. commitments abroad",
    ],
    topicKeywords: ["foreign policy", "NATO", "alliances"],
    trial: buildTrial(6, "Alliance Commitment Campaign Trial", "Campaign-linked benchmark for alliance commitment and burden sharing."),
    campaign: buildCampaign(1, "Alliance Credibility Campaign", "Measure attitudes toward NATO commitment and burden sharing."),
    personaSelections: {
      progressive: selection(0, "supports a strong NATO commitment", "backs maintaining alliance commitments abroad", ["strong NATO", "alliances", "international commitment"], { ideologyHint: "progressive" }),
      conservative: selection(1, "supports NATO with stronger burden sharing", "backs alliances while pushing allies to contribute more", ["burden sharing", "NATO", "allied contributions"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports NATO with stronger burden sharing", "backs a balanced alliance posture with shared costs", ["burden sharing", "balanced alliance", "shared costs"], { ideologyHint: "moderate" }),
      libertarian: selection(2, "supports scaling back overseas commitments", "backs a more restrained foreign-policy posture", ["scale back commitments", "restraint", "anti-intervention"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-019",
    type: "campaign_poll",
    title: "Should cities shift some police funding to mental health crisis teams?",
    description: "A campaign-linked criminal-justice poll contrasting funding shifts, pilots, and a keep-policing status quo.",
    options: [
      "Shift some police funding to mental health crisis teams",
      "Run limited pilots with co-response teams",
      "Keep police funding in traditional departments",
    ],
    topicKeywords: ["criminal justice", "policing", "mental health response"],
    trial: buildTrial(7, "Crisis Response Campaign Trial", "Campaign-linked benchmark for police funding and crisis-response alternatives."),
    campaign: buildCampaign(2, "Community Safety Campaign", "Measure support for crisis teams versus traditional police funding."),
    personaSelections: {
      progressive: selection(0, "supports shifting some funding to crisis teams", "backs reallocating part of policing budgets to mental health response", ["shift funding", "crisis teams", "reallocation"], { ideologyHint: "progressive" }),
      conservative: selection(2, "supports keeping police funding in traditional departments", "backs a traditional policing funding model", ["keep police funding", "traditional policing", "law and order"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports limited pilots for co-response teams", "backs cautious experimentation with crisis-response alternatives", ["pilot programs", "co-response", "incremental reform"], { ideologyHint: "moderate" }),
      libertarian: selection(1, "supports limited pilots for co-response teams", "backs a limited alternative-response experiment without a large mandate", ["pilot programs", "limited experiment", "local flexibility"], { ideologyHint: "libertarian" }),
    },
  },
  {
    pollId: "bench-poll-020",
    type: "campaign_poll",
    title: "Should new natural gas export terminals be approved to boost jobs and energy security?",
    description: "A campaign-linked energy poll contrasting energy expansion, conditional approval, and climate-first rejection.",
    options: [
      "Approve more natural gas export terminals quickly",
      "Approve some terminals with stricter environmental review",
      "Stop new terminals and prioritize clean energy instead",
    ],
    topicKeywords: ["energy policy", "natural gas", "exports"],
    trial: buildTrial(8, "Energy Security Campaign Trial", "Campaign-linked benchmark for gas exports, jobs, and clean-energy priorities."),
    campaign: buildCampaign(3, "Energy Security Campaign", "Measure support for gas export terminals versus climate-first constraints."),
    personaSelections: {
      progressive: selection(2, "opposes new gas terminals and prefers clean energy", "backs climate-first limits on fossil-fuel export infrastructure", ["clean energy", "stop new terminals", "climate-first"], { ideologyHint: "progressive" }),
      conservative: selection(0, "supports quick approval of new gas terminals", "backs fossil-energy expansion for jobs and energy security", ["approve terminals", "energy security", "jobs"], { ideologyHint: "conservative" }),
      moderate: selection(1, "supports conditional approval with tighter review", "backs a balanced energy-security position with environmental conditions", ["environmental review", "conditional approval", "balanced energy policy"], { ideologyHint: "moderate" }),
      libertarian: selection(0, "supports quick approval of new gas terminals", "backs faster energy permitting and export growth", ["approve terminals", "faster permitting", "market expansion"], { ideologyHint: "libertarian" }),
    },
  },
];

function buildExpectedRelationships(args: {
  poll: BenchmarkPollDefinition;
  expectation: BenchmarkOptionExpectation;
}): PoliticalBenchmarkRelationshipExpectation[] {
  const relationships: PoliticalBenchmarkRelationshipExpectation[] = [
    { from: "User", type: "MADE_ASSERTION", to: "Assertion" },
    { from: "Assertion", type: "ABOUT", to: "Topic" },
  ];

  if (args.poll.entity && args.expectation.entitySentiment) {
    relationships.push({ from: "Assertion", type: "TARGETS", to: "Entity" });
  } else {
    relationships.push({ from: "Assertion", type: "TARGETS", to: "Position" });
  }

  return relationships;
}

export function buildPoliticalBenchmarkBundle(): {
  votes: RawVote[];
  manifest: PoliticalBenchmarkManifest;
} {
  const votes: RawVote[] = [];
  const voteExpectations: PoliticalBenchmarkVoteExpectation[] = [];
  const voteTypeCounts: Record<VoteItemType, number> = {
    standalone_poll: 0,
    trial_poll: 0,
    campaign_poll: 0,
    inkd_poll: 0,
  };
  const pollTypeCounts: Record<VoteItemType, number> = {
    standalone_poll: 0,
    trial_poll: 0,
    campaign_poll: 0,
    inkd_poll: 0,
  };

  benchmarkPolls.forEach((poll, pollIndex) => {
    pollTypeCounts[poll.type] += 1;
    const assignedVoters = voterGroups[pollIndex % voterGroups.length];

    assignedVoters.forEach((voter, voteOffset) => {
      const expectation = poll.personaSelections[voter.persona];
      const voteNumber = votes.length + 1;
      const voteId = `bench-vote-${String(voteNumber).padStart(3, "0")}`;
      const pollDay = 3 + Math.floor(pollIndex / 4) * 5 + (pollIndex % 4);
      const seenAt = isoDate(pollDay, 10 + voteOffset, pollIndex);
      const respondedAt = isoDate(pollDay, 10 + voteOffset, pollIndex + 2);
      const pollOptions = poll.options.map((text, optionIndex) => ({
        text,
        isSelected: optionIndex === expectation.optionIndex,
      }));

      const vote: RawVote = {
        type: poll.type,
        voteId,
        timestamps: {
          seenAt,
          respondedAt,
        },
        voter: {
          externalAccountId: voter.externalAccountId,
          username: voter.username,
          googleEmail: voter.googleEmail,
          emailAuthEmail: voter.googleEmail,
          gender: voter.gender,
          dob: voter.dob,
          civicScore: voter.civicScore,
          level: voter.level,
          location: voter.location,
        },
        poll: {
          pollId: poll.pollId,
          title: poll.title,
          description: poll.description,
          createdAt: isoDate(pollDay - 1, 8, 0),
          options: pollOptions,
        },
        ...(poll.trial ? { trial: poll.trial } : {}),
        ...(poll.campaign ? { campaign: poll.campaign } : {}),
      };

      votes.push(vote);
      voteTypeCounts[poll.type] += 1;

      voteExpectations.push({
        voteId,
        pollId: poll.pollId,
        voteType: poll.type,
        voterExternalAccountId: voter.externalAccountId,
        voterPersona: voter.persona,
        selectedOption: poll.options[expectation.optionIndex],
        plainEnglishMeaning: expectation.plainEnglishMeaning,
        expectedSemanticIntent: expectation.semanticIntent,
        expectedTopicKeywords: poll.topicKeywords,
        expectedTargetKeywords: expectation.stanceKeywords,
        expectedEntity: poll.entity,
        expectedEntitySentiment: expectation.entitySentiment,
        expectedIdeologyHint: expectation.ideologyHint,
        expectedGraphRelationships: buildExpectedRelationships({
          poll,
          expectation,
        }),
      });
    });
  });

  return {
    votes,
    manifest: {
      datasetName: POLITICAL_BENCHMARK_DATASET_NAME,
      description:
        "A deterministic 100-vote political benchmark with mixed standalone, trial, and campaign polls for validating LLM semantics, Qdrant subject dedupe, and Neo4j semantic-only assertion writes.",
      generatedAt: "2026-04-04T00:00:00.000Z",
      aggregateExpectations: {
        expectedVoteCount: 100,
        expectedUserCount: 20,
        expectedPollCount: 20,
        expectedTrialNodeCount: 8,
        expectedCampaignNodeCount: 3,
        expectedPollTypeCounts: {
          standalone_poll: pollTypeCounts.standalone_poll,
          trial_poll: pollTypeCounts.trial_poll,
          campaign_poll: pollTypeCounts.campaign_poll,
          inkd_poll: pollTypeCounts.inkd_poll,
        },
        expectedVoteTypeCounts: {
          standalone_poll: voteTypeCounts.standalone_poll,
          trial_poll: voteTypeCounts.trial_poll,
          campaign_poll: voteTypeCounts.campaign_poll,
          inkd_poll: voteTypeCounts.inkd_poll,
        },
      },
      personaExpectations: [
        {
          persona: "progressive",
          userCount: 5,
          expectedVoteCount: 25,
          commonTargetKeywords: ["public investment", "expanded rights", "reform", "social support"],
          commonIdeologyKeywords: ["progressive", "center-left"],
          summary:
            "Progressive voters in this benchmark repeatedly back public investment, expanded rights, climate action, housing growth, and accountability reforms.",
        },
        {
          persona: "conservative",
          userCount: 5,
          expectedVoteCount: 25,
          commonTargetKeywords: ["border enforcement", "tax cuts", "law and order", "energy expansion"],
          commonIdeologyKeywords: ["conservative", "right-leaning"],
          summary:
            "Conservative voters in this benchmark repeatedly favor harder border stances, tax cuts, traditional policing, and fossil-energy or market-friendly policies.",
        },
        {
          persona: "moderate",
          userCount: 5,
          expectedVoteCount: 25,
          commonTargetKeywords: ["incremental reform", "case-by-case review", "pilot programs", "burden sharing"],
          commonIdeologyKeywords: ["moderate", "centrist"],
          summary:
            "Moderate voters in this benchmark usually choose compromise language, limited pilots, incremental reforms, and shared-cost approaches.",
        },
        {
          persona: "libertarian",
          userCount: 5,
          expectedVoteCount: 25,
          commonTargetKeywords: ["market solutions", "civil liberties", "small government", "deregulation"],
          commonIdeologyKeywords: ["libertarian", "small-government"],
          summary:
            "Libertarian voters in this benchmark tend to prefer market-led solutions, reduced state control, civil-liberty framing, and restrained foreign commitments.",
        },
      ],
      voteExpectations,
    },
  };
}
