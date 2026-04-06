import neo4j, { type Driver, type Session } from "neo4j-driver";

type DatabaseConfig = {
  label: string;
  uri: string;
  username: string;
  password: string;
  database: string;
};

type PropertyMap = Record<string, unknown>;

type GraphCounts = {
  nodes: number;
  relationships: number;
};

type SchemaSnapshot = {
  constraints: string[];
  indexes: string[];
};

type NodeCopyRow = {
  sourceElementId: string;
  labels: string[];
  properties: PropertyMap;
};

type RelationshipCopyRow = {
  relationshipElementId: string;
  type: string;
  fromId: string;
  toId: string;
  properties: PropertyMap;
};

const FROM_DB: DatabaseConfig = {
  label: "Docker Neo4j",
  uri: "bolt://localhost:7687",
  username: "neo4j",
  password: "xpolllocal12345",
  database: "neo4j",
};

const TO_DB: DatabaseConfig = {
  label: "Neo4j Aura",
  uri: "neo4j+s://29e9a5ea.databases.neo4j.io",
  username: "29e9a5ea",
  password: "IxCc_EvL-LV7TrnLyjllGOiX_7PQF6UB74LgYjt_4v4",
  database: "29e9a5ea",
};

const COPY_SCHEMA = true;
const CLEAR_TARGET_BEFORE_COPY = true;
const NODE_BATCH_SIZE = 500;
const RELATIONSHIP_BATCH_SIZE = 1_000;
const DELETE_BATCH_SIZE = 1_000;
const TEMP_LABEL = "__CodexNeo4jMigration__";
const TEMP_ID_PROPERTY = "__CodexNeo4jSourceElementId__";
const TEMP_CONSTRAINT_NAME = "codex_neo4j_migration_source_element_id_unique";
const DEFAULT_DATABASE_FALLBACK = "neo4j";

function ensureSupportedRuntime(): void {
  if (typeof Bun !== "undefined") {
    throw new Error(
      'This script must run on Node.js for Aura connectivity. Use "bun run copy:neo4j:aura" so Bun invokes the Node-based package script.',
    );
  }
}

function logInfo(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logError(message: string, error?: unknown): void {
  if (error === undefined) {
    console.error(`[${new Date().toISOString()}] ${message}`);
    return;
  }

  console.error(`[${new Date().toISOString()}] ${message}`, error);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }

  return Number(value ?? 0);
}

function createDriver(config: DatabaseConfig): Driver {
  return neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.username, config.password),
  );
}

function buildNodeCreateQuery(labels: string[]): string {
  const labelSegment = [TEMP_LABEL, ...labels]
    .map(escapeIdentifier)
    .map((label) => `:${label}`)
    .join("");

  return `
    UNWIND $rows AS row
    CREATE (n${labelSegment})
    SET n = row.properties
    SET n.${escapeIdentifier(TEMP_ID_PROPERTY)} = row.sourceElementId
  `;
}

function buildRelationshipCreateQuery(type: string): string {
  return `
    UNWIND $rows AS row
    MATCH (source:${escapeIdentifier(TEMP_LABEL)} {${escapeIdentifier(TEMP_ID_PROPERTY)}: row.fromId})
    MATCH (target:${escapeIdentifier(TEMP_LABEL)} {${escapeIdentifier(TEMP_ID_PROPERTY)}: row.toId})
    CREATE (source)-[r:${escapeIdentifier(type)}]->(target)
    SET r = row.properties
  `;
}

function ensureIfNotExists(createStatement: string): string {
  const trimmed = createStatement.trim().replace(/;$/, "");
  const uppercase = trimmed.toUpperCase();

  if (uppercase.includes(" IF NOT EXISTS ")) {
    return trimmed;
  }

  const markerIndex = uppercase.indexOf(" FOR ");
  if (markerIndex === -1) {
    return trimmed;
  }

  return `${trimmed.slice(0, markerIndex)} IF NOT EXISTS${trimmed.slice(markerIndex)}`;
}

async function runStep<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  logInfo(`${label}...`);

  try {
    const result = await action();
    logInfo(`${label} completed in ${Date.now() - startedAt}ms.`);
    return result;
  } catch (error) {
    logError(`${label} failed after ${Date.now() - startedAt}ms.`, error);
    throw error;
  }
}

async function verifyConnection(driver: Driver, config: DatabaseConfig): Promise<void> {
  await driver.verifyConnectivity();
}

function buildDatabaseCandidates(config: DatabaseConfig): string[] {
  const candidates = [config.database, DEFAULT_DATABASE_FALLBACK].filter(
    (value): value is string => Boolean(value),
  );

  return [...new Set(candidates)];
}

async function resolveUsableDatabase(driver: Driver, config: DatabaseConfig): Promise<string> {
  let lastError: unknown;

  for (const database of buildDatabaseCandidates(config)) {
    const session = driver.session({ database });

    try {
      await session.run("RETURN 1 AS ok");

      if (database !== config.database) {
        logInfo(
          `${config.label} database fallback applied. Using "${database}" instead of configured "${config.database}".`,
        );
      }

      return database;
    } catch (error) {
      lastError = error;
    } finally {
      await session.close();
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to resolve a usable database for ${config.label}.`);
}

async function ensureTempMarkersDoNotConflict(sourceSession: Session): Promise<void> {
  const result = await sourceSession.run(
    `
      MATCH (n)
      WHERE $tempLabel IN labels(n)
        OR any(key IN keys(n) WHERE key = $tempProperty)
      RETURN count(n) AS conflictCount
    `,
    {
      tempLabel: TEMP_LABEL,
      tempProperty: TEMP_ID_PROPERTY,
    },
  );

  const conflictCount = toNumber(result.records[0]?.get("conflictCount"));
  if (conflictCount > 0) {
    throw new Error(
      `Migration temp marker conflict detected on ${conflictCount} source node(s). Change TEMP_LABEL or TEMP_ID_PROPERTY before running again.`,
    );
  }
}

async function getGraphCounts(session: Session): Promise<GraphCounts> {
  const result = await session.run(`
    CALL {
      MATCH (n)
      RETURN count(n) AS nodeCount
    }
    CALL {
      MATCH ()-[r]->()
      RETURN count(r) AS relationshipCount
    }
    RETURN nodeCount, relationshipCount
  `);

  return {
    nodes: toNumber(result.records[0]?.get("nodeCount")),
    relationships: toNumber(result.records[0]?.get("relationshipCount")),
  };
}

async function readSchema(session: Session): Promise<SchemaSnapshot> {
  const constraintsResult = await session.run(`
    SHOW CONSTRAINTS
    YIELD createStatement
    WHERE createStatement IS NOT NULL
    RETURN createStatement
    ORDER BY createStatement
  `);
  const indexesResult = await session.run(`
    SHOW INDEXES
    YIELD type, createStatement
    WHERE createStatement IS NOT NULL AND type <> 'LOOKUP'
    RETURN createStatement
    ORDER BY createStatement
  `);

  return {
    constraints: constraintsResult.records.map((record) => String(record.get("createStatement"))),
    indexes: indexesResult.records.map((record) => String(record.get("createStatement"))),
  };
}

async function clearTargetData(targetSession: Session): Promise<number> {
  let deleted = 0;

  while (true) {
    const result = await targetSession.run(
      `
        MATCH (n)
        WITH n LIMIT $batchSize
        DETACH DELETE n
        RETURN count(n) AS deletedCount
      `,
      { batchSize: neo4j.int(DELETE_BATCH_SIZE) },
    );

    const batchDeleted = toNumber(result.records[0]?.get("deletedCount"));
    if (batchDeleted === 0) {
      return deleted;
    }

    deleted += batchDeleted;
    logInfo(`Deleted ${deleted} node(s) from target so far.`);
  }
}

async function createTempConstraint(targetSession: Session): Promise<void> {
  await targetSession.run(`
    CREATE CONSTRAINT ${escapeIdentifier(TEMP_CONSTRAINT_NAME)} IF NOT EXISTS
    FOR (n:${escapeIdentifier(TEMP_LABEL)})
    REQUIRE n.${escapeIdentifier(TEMP_ID_PROPERTY)} IS UNIQUE
  `);
}

async function dropTempConstraint(targetSession: Session): Promise<void> {
  await targetSession.run(`DROP CONSTRAINT ${escapeIdentifier(TEMP_CONSTRAINT_NAME)} IF EXISTS`);
}

async function cleanupTempMarkers(targetSession: Session): Promise<number> {
  let cleaned = 0;

  while (true) {
    const result = await targetSession.run(
      `
        MATCH (n:${escapeIdentifier(TEMP_LABEL)})
        WITH n LIMIT $batchSize
        REMOVE n.${escapeIdentifier(TEMP_ID_PROPERTY)}
        REMOVE n:${escapeIdentifier(TEMP_LABEL)}
        RETURN count(n) AS cleanedCount
      `,
      { batchSize: neo4j.int(DELETE_BATCH_SIZE) },
    );

    const batchCleaned = toNumber(result.records[0]?.get("cleanedCount"));
    if (batchCleaned === 0) {
      return cleaned;
    }

    cleaned += batchCleaned;
    logInfo(`Cleaned migration markers from ${cleaned} node(s) so far.`);
  }
}

function groupNodeRowsByLabels(rows: NodeCopyRow[]): Map<string, NodeCopyRow[]> {
  const groups = new Map<string, NodeCopyRow[]>();

  for (const row of rows) {
    const labels = [...row.labels].sort();
    const key = labels.join("\u0000");
    const group = groups.get(key) ?? [];

    group.push({
      ...row,
      labels,
    });

    groups.set(key, group);
  }

  return groups;
}

function groupRelationshipRowsByType(rows: RelationshipCopyRow[]): Map<string, RelationshipCopyRow[]> {
  const groups = new Map<string, RelationshipCopyRow[]>();

  for (const row of rows) {
    const group = groups.get(row.type) ?? [];
    group.push(row);
    groups.set(row.type, group);
  }

  return groups;
}

async function copyNodes(sourceSession: Session, targetSession: Session, totalNodes: number): Promise<number> {
  let copied = 0;

  while (true) {
    const result = await sourceSession.run(
      `
        MATCH (n)
        RETURN elementId(n) AS sourceElementId, labels(n) AS labels, properties(n) AS properties
        ORDER BY sourceElementId
        SKIP $skip
        LIMIT $limit
      `,
      {
        skip: neo4j.int(copied),
        limit: neo4j.int(NODE_BATCH_SIZE),
      },
    );

    if (result.records.length === 0) {
      return copied;
    }

    const rows: NodeCopyRow[] = result.records.map((record) => ({
      sourceElementId: String(record.get("sourceElementId")),
      labels: ((record.get("labels") as string[] | undefined) ?? []).map(String),
      properties: (record.get("properties") as PropertyMap | undefined) ?? {},
    }));

    const groupedRows = groupNodeRowsByLabels(rows);
    for (const batchRows of groupedRows.values()) {
      const query = buildNodeCreateQuery(batchRows[0]?.labels ?? []);
      const payload = batchRows.map(({ sourceElementId, properties }) => ({
        sourceElementId,
        properties,
      }));

      await targetSession.executeWrite((tx) => tx.run(query, { rows: payload }));
    }

    copied += rows.length;
    logInfo(`Copied ${copied}/${totalNodes} node(s).`);
  }
}

async function copyRelationships(
  sourceSession: Session,
  targetSession: Session,
  totalRelationships: number,
): Promise<number> {
  let copied = 0;

  while (true) {
    const result = await sourceSession.run(
      `
        MATCH ()-[r]->()
        RETURN elementId(r) AS relationshipElementId,
               type(r) AS relationshipType,
               elementId(startNode(r)) AS fromId,
               elementId(endNode(r)) AS toId,
               properties(r) AS properties
        ORDER BY relationshipElementId
        SKIP $skip
        LIMIT $limit
      `,
      {
        skip: neo4j.int(copied),
        limit: neo4j.int(RELATIONSHIP_BATCH_SIZE),
      },
    );

    if (result.records.length === 0) {
      return copied;
    }

    const rows: RelationshipCopyRow[] = result.records.map((record) => ({
      relationshipElementId: String(record.get("relationshipElementId")),
      type: String(record.get("relationshipType")),
      fromId: String(record.get("fromId")),
      toId: String(record.get("toId")),
      properties: (record.get("properties") as PropertyMap | undefined) ?? {},
    }));

    const groupedRows = groupRelationshipRowsByType(rows);
    for (const [relationshipType, batchRows] of groupedRows.entries()) {
      const query = buildRelationshipCreateQuery(relationshipType);
      const payload = batchRows.map(({ fromId, toId, properties }) => ({
        fromId,
        toId,
        properties,
      }));

      await targetSession.executeWrite((tx) => tx.run(query, { rows: payload }));
    }

    copied += rows.length;
    logInfo(`Copied ${copied}/${totalRelationships} relationship(s).`);
  }
}

async function applySchema(targetSession: Session, schema: SchemaSnapshot): Promise<void> {
  for (const statement of schema.constraints) {
    await targetSession.run(ensureIfNotExists(statement));
  }

  for (const statement of schema.indexes) {
    await targetSession.run(ensureIfNotExists(statement));
  }
}

export async function runCopyNeo4jToAura(): Promise<void> {
  ensureSupportedRuntime();

  if (
    FROM_DB.uri === TO_DB.uri &&
    FROM_DB.database === TO_DB.database &&
    FROM_DB.username === TO_DB.username
  ) {
    throw new Error("Source and target databases resolve to the same connection details. Aborting copy.");
  }

  const sourceDriver = createDriver(FROM_DB);
  const targetDriver = createDriver(TO_DB);
  let sourceSession: Session | null = null;
  let targetSession: Session | null = null;
  let targetPrepared = false;

  try {
    logInfo(`Copying graph data from ${FROM_DB.label} to ${TO_DB.label}.`);
    logInfo(`Source: ${FROM_DB.uri} / ${FROM_DB.database}`);
    logInfo(`Target: ${TO_DB.uri} / ${TO_DB.database}`);

    await runStep(`Verifying ${FROM_DB.label} connectivity`, () => verifyConnection(sourceDriver, FROM_DB));
    await runStep(`Verifying ${TO_DB.label} connectivity`, () => verifyConnection(targetDriver, TO_DB));

    const sourceDatabase = await runStep(`Resolving ${FROM_DB.label} database`, () =>
      resolveUsableDatabase(sourceDriver, FROM_DB),
    );
    const targetDatabase = await runStep(`Resolving ${TO_DB.label} database`, () =>
      resolveUsableDatabase(targetDriver, TO_DB),
    );

    sourceSession = sourceDriver.session({ database: sourceDatabase });
    targetSession = targetDriver.session({ database: targetDatabase });
    const activeSourceSession = sourceSession;
    const activeTargetSession = targetSession;

    await runStep("Checking for migration temp marker conflicts in source data", () =>
      ensureTempMarkersDoNotConflict(activeSourceSession),
    );

    const sourceCounts = await runStep("Reading source graph counts", () => getGraphCounts(activeSourceSession));
    logInfo(
      `Source graph has ${sourceCounts.nodes} node(s) and ${sourceCounts.relationships} relationship(s).`,
    );

    const schema = COPY_SCHEMA
      ? await runStep("Reading source schema", () => readSchema(activeSourceSession))
      : { constraints: [], indexes: [] };

    if (CLEAR_TARGET_BEFORE_COPY) {
      await runStep("Clearing existing target data", () => clearTargetData(activeTargetSession));
    }

    await runStep("Creating temporary migration constraint on target", () =>
      createTempConstraint(activeTargetSession),
    );
    targetPrepared = true;
    await runStep("Copying nodes", () =>
      copyNodes(activeSourceSession, activeTargetSession, sourceCounts.nodes),
    );
    await runStep("Copying relationships", () =>
      copyRelationships(activeSourceSession, activeTargetSession, sourceCounts.relationships),
    );

    if (COPY_SCHEMA) {
      await runStep("Applying source schema to target", () => applySchema(activeTargetSession, schema));
    }

    await runStep("Cleaning temporary migration markers", () => cleanupTempMarkers(activeTargetSession));
    await runStep("Dropping temporary migration constraint", () => dropTempConstraint(activeTargetSession));

    const targetCounts = await runStep("Reading target graph counts", () => getGraphCounts(activeTargetSession));

    if (
      sourceCounts.nodes !== targetCounts.nodes ||
      sourceCounts.relationships !== targetCounts.relationships
    ) {
      throw new Error(
        `Copy finished, but counts do not match. Source=${JSON.stringify(sourceCounts)} Target=${JSON.stringify(targetCounts)}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          source: {
            database: FROM_DB.database,
            uri: FROM_DB.uri,
            counts: sourceCounts,
          },
          target: {
            database: TO_DB.database,
            uri: TO_DB.uri,
            counts: targetCounts,
          },
          copiedSchema: COPY_SCHEMA,
        },
        null,
        2,
      ),
    );

    logInfo("Neo4j copy completed successfully.");
  } finally {
    if (targetPrepared && targetSession !== null) {
      try {
        await cleanupTempMarkers(targetSession);
      } catch (error) {
        logError("Best-effort cleanup of migration markers failed.", error);
      }

      try {
        await dropTempConstraint(targetSession);
      } catch (error) {
        logError("Best-effort drop of migration constraint failed.", error);
      }
    }

    await Promise.allSettled([
      sourceSession?.close(),
      targetSession?.close(),
      sourceDriver.close(),
      targetDriver.close(),
    ]);
  }
}

if (import.meta.main) {
  runCopyNeo4jToAura().catch((error) => {
    logError("Fatal error while copying Neo4j data.", error);
    console.error(
      JSON.stringify(
        {
          success: false,
          error: toErrorMessage(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}
