const QUERY_STORAGE_CONTRACT_LINES = [
  "Storage contract for this Graph RAG system:",
  "- Neo4j stores semantic retrieval facts as User -> Assertion -> Subject, with optional Assertion -> ABOUT -> Topic.",
  "- Users are identified by externalAccountId; usernames and emails are metadata only.",
  "- Cohort filters use shared user-dimension relationships: IN_COUNTRY, IN_STATE, IN_CITY, HAS_GENDER.",
  "- Qdrant subject registry stores candidate concepts with canonicalId, canonicalLabel, subjectKind, normalizedLabel, aliases, and aliasesNormalized.",
  "- Qdrant progress/evidence records are keyed by voteId.",
  "- Exact, alias, and vector subject-registry hits are candidate concepts only; they do not prove a user stance by themselves.",
  "- A matched user and matched concept do not imply a connecting assertion exists in the graph.",
  "- Final answers must distinguish between candidate concept matches and assertion-backed evidence.",
];

export function buildQueryStorageContract(maxChars = 4000): string {
  const contract = QUERY_STORAGE_CONTRACT_LINES.join("\n");
  return contract.length <= maxChars ? contract : `${contract.slice(0, maxChars)}\n[truncated]`;
}
