/**
 * Types for the raw input structure and for the small semantic objects that the POC creates.
 * The goal here is to keep the first version easy to inspect.
 */

export type StoreStageStatus = "pending" | "done" | "failed";

export type ProcessingStatus = "completed" | "failed_retryable" | "skipped_terminal" | "conflict";

export type DatasetMode = "test" | "main";

export type ImportStage =
  | "openai"
  | "qdrant_concepts"
  | "qdrant_progress"
  | "neo4j"
  | "finalize_qdrant"
  | "finalize_neo4j"
  | "reconcile"
  | "validation";

export type VoteItemType = "standalone_poll" | "trial_poll" | "campaign_poll" | "inkd_poll";
export type SubjectKind = "topic" | "position" | "entity" | "ideology";
export type AssertionTargetKind = Exclude<SubjectKind, "ideology">;
export type RegistryEntryKind = "subject";
export type RelationPolarity = "positive" | "negative" | "neutral";
export type RegistryMatchType = "exact" | "vector" | "created";
export type IntensityBand = "weak" | "medium" | "strong";

export type RawVote = {
  type: VoteItemType | string;
  voteId: string;
  timestamps?: {
    seenAt?: string | null;
    respondedAt?: string | null;
  };
  voter: {
    externalAccountId: string;
    username?: string | null;
    twitterUsername?: string | null;
    twitterName?: string | null;
    googleEmail?: string | null;
    emailAuthEmail?: string | null;
    gender?: string | null;
    dob?: string | null;
    civicScore?: number | null;
    level?: number | null;
    location?: {
      city?: string | null;
      state?: string | null;
      country?: string | null;
    } | null;
  };
  poll: {
    pollId: string;
    title: string;
    description?: string | null;
    createdAt?: string | null;
    options: Array<{
      text: string;
      isSelected: boolean;
    }>;
  };
  trial?: {
    trialId?: string | null;
    title?: string | null;
    description?: string | null;
    createdAt?: string | null;
  } | null;
  campaign?: {
    campaignId?: string | null;
    name?: string | null;
    goal?: string | null;
    isPolitical?: boolean | null;
    createdAt?: string | null;
  } | null;
  inkdBlog?: {
    inkdBlogId?: string | null;
    title?: string | null;
    description?: string | null;
    createdAt?: string | null;
  } | null;
  trialCast?: {
    trialCastId?: string | null;
    pollIds?: string[];
  } | null;
};

export type RawEvidenceSnapshot = {
  voteId: string;
  voteType: VoteItemType | string;
  selectedOption: string | null;
  voteTimestamps?: {
    seenAt?: string | null;
    respondedAt?: string | null;
  };
  poll: {
    pollId: string;
    title: string;
    description?: string | null;
    createdAt?: string | null;
    options: Array<{
      text: string;
      isSelected: boolean;
    }>;
  };
  trial?: RawVote["trial"];
  campaign?: RawVote["campaign"];
  inkdBlog?: RawVote["inkdBlog"];
  rawVote: RawVote;
};

export type PollSemanticTemplate = {
  pollKey: string;
  pollFingerprint: string;
  canonicalTopic: {
    label: string;
    aliases?: string[];
  };
  options: Array<{
    optionText: string;
    canonicalTargetLabel: string;
    targetKind: AssertionTargetKind;
    relationFamily: string;
    polarity: RelationPolarity;
    intensityBand: IntensityBand;
    aliases?: string[];
    notes: string[];
  }>;
  notes: string[];
};

export type InferredSemantics = {
  assertions: Array<{
    relationFamily: string;
    polarity: RelationPolarity;
    targetLabel: string;
    targetKind: AssertionTargetKind;
    aboutTopicLabel?: string;
    ideologyHint?: string;
    confidence?: number;
    intensityBand?: IntensityBand;
    baseIntensityContribution?: number;
    notes: string[];
  }>;
  notes: string[];
};

export type ResolvedSubject = {
  entryKind: "subject";
  canonicalId: string;
  label: string;
  kind: SubjectKind;
  topicCanonicalId?: string;
  aliases?: string[];
  matchType: RegistryMatchType;
  matchScore?: number;
};

export type ResolvedAssertion = {
  assertionSignature: string;
  relationId: string;
  relationLabel: string;
  relationFamily: string;
  polarity: RelationPolarity;
  target: ResolvedSubject;
  aboutTopic?: ResolvedSubject | null;
  assertionGroupKey: string;
  intensityBand: IntensityBand;
  baseIntensityContribution: number;
  confidence: number;
  notes: string[];
};

export type VoteIterationItem = {
  sourceIndex: number;
  vote: RawVote;
};

export type VoteInputDescriptor = {
  inputPath: string;
  resolvedPath: string;
  inputKind: "file" | "directory";
  sources: VoteSourceDescriptor[];
};

export type VoteSourceDescriptor = {
  sourcePath: string;
  sourceRunKey: string;
  fileSize: number;
  fileMtimeMs: number;
};

export type ResolvedVoteArtifact = {
  processingKey: string;
  sourceRunKey: string;
  sourcePath: string;
  sourceIndex: number;
  voteId: string;
  pollKey?: string;
  pollFingerprint?: string;
  artifactFingerprint?: string;
  rawEvidence?: RawEvidenceSnapshot;
  pollTemplate?: PollSemanticTemplate;
  semantics?: InferredSemantics;
  resolvedSubjects?: ResolvedSubject[];
  resolvedAssertions?: ResolvedAssertion[];
  qdrantStatus: StoreStageStatus;
  neo4jStatus: StoreStageStatus;
  finalStatus: StoreStageStatus;
  processingStatus?: ProcessingStatus;
  attemptCount: number;
  startedAt?: string;
  qdrantCompletedAt?: string;
  neo4jCompletedAt?: string;
  completedAt?: string;
  lastErrorStage?: ImportStage;
  lastErrorMessage?: string;
  lastUpdatedAt: string;
};
