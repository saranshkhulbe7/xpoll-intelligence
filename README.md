# xpoll-intelligence

To install dependencies:

```bash
bun install
```

Create a `.env` file from `.env.example` and set your `OPENAI_API_KEY`, Neo4j credentials, and Qdrant credentials before running the importer.
Set `DATASET_MODE` to `main` for the real split files or `test` for the synthetic benchmark.
Set `VOTES_JSON_PATH` to either a single vote JSON file or a directory of split JSON files such as `./db/decompose`.
Set `PROCESS_TILL_FIRST_N_VOTES` to a positive integer such as `10` for a capped test run, or `null` to process all votes.

The importer validates the path against `DATASET_MODE` before it starts:

- `DATASET_MODE=main` cannot point at `./db/test-data`
- `DATASET_MODE=test` must point at `./db/test-data`

The importer now uses a Qdrant semantic registry for canonical subjects plus a dedicated Qdrant progress collection so interrupted runs can resume safely without reprocessing completed votes.
Neo4j writes now focus on the semantic graph only: `User`, `Subject`, and `Assertion`. Raw vote and poll evidence is stored as compact assertion metadata in Neo4j and as full progress metadata in Qdrant, not as first-class graph nodes.
Assertions also carry a decaying `currentIntensity` score that represents how strongly the user currently appears to hold that relation, separate from model `confidence` and `evidenceCount`.
It also logs per-vote JSON progress as `processedVotes/totalVotes` with a percentage, using a full counting pass across all input files before processing begins.

Benchmark data is available at:

- `./db/test-data/political-benchmark-100.json`
- `./db/test-data/political-benchmark-100.expected.json`

The expected manifest gives you the intended meaning of each synthetic vote, the topic and target keywords it should surface, optional entity and ideology hints, and the semantic relationships that should exist after import.

To run Neo4j locally with Docker Compose:

```bash
docker compose up -d
```

This starts Neo4j on:

- `http://localhost:7474` for Neo4j Browser
- `bolt://localhost:7687` for the importer

The default local credentials in this repo are:

- username: `neo4j`
- password: `xpolllocal12345`

Once the container is healthy, open `http://localhost:7474`, sign in, and you can visualize the imported graph there.

To run:

```bash
bun run src/index.ts
```

To query the current graph from the terminal:

```bash
bun run query -- --ask "What are Maya Sen's strongest current views?"
```

Optional query flags:

- `--limit 5` to control how many results are retrieved per cluster
- `--json` to return the structured retrieval payload instead of prose

Example query commands:

```bash
bun run query -- --ask "How does Maya Sen feel about Joe Biden?"
bun run query -- --ask "Who is positive toward Bernie Sanders?"
bun run query -- --ask "What does Maya Sen think about immigration?"
bun run query -- --ask "Compare Maya Sen and Ethan Clark on healthcare coverage policy"
```

Example `main` setup:

```env
DATASET_MODE=main
VOTES_JSON_PATH=./db/decompose
PROCESS_TILL_FIRST_N_VOTES=null
```

Example `test` setup:

```env
DATASET_MODE=test
VOTES_JSON_PATH=./db/test-data/political-benchmark-100.json
PROCESS_TILL_FIRST_N_VOTES=10
```

Intensity tuning defaults:

```env
INTENSITY_HALF_LIFE_DAYS=180
INTENSITY_OPPOSITE_SUPPRESSION=0.70
```

To compute exact-now intensity on read from the stored `intensityMass` and `lastIntensityDecayAt`, use a query like:

```cypher
WITH datetime() AS now,
     log(2.0) / (180.0 * 86400.0) AS lambda,
     0.70 AS suppression
MATCH (u:User)-[:MADE_ASSERTION]->(a:Assertion)-[:TARGETS]->(s:Subject)
OPTIONAL MATCH (opp:Assertion {assertionGroupKey: a.assertionGroupKey})
WHERE opp IS NULL OR opp.polarity <> a.polarity
WITH u, a, s, opp, lambda, suppression, now,
     CASE
       WHEN a.lastIntensityDecayAt IS NULL THEN coalesce(a.intensityMass, 0.0)
       ELSE coalesce(a.intensityMass, 0.0) * exp(-lambda * duration.between(datetime(a.lastIntensityDecayAt), now).seconds)
     END AS ownMassNow,
     CASE
       WHEN opp IS NULL THEN 0.0
       WHEN opp.lastIntensityDecayAt IS NULL THEN coalesce(opp.intensityMass, 0.0)
       ELSE coalesce(opp.intensityMass, 0.0) * exp(-lambda * duration.between(datetime(opp.lastIntensityDecayAt), now).seconds)
     END AS oppositeMassNow
RETURN
  u.username,
  a.relationLabel,
  s.label,
  1 - exp(-max(0.0, ownMassNow - suppression * oppositeMassNow)) AS exactNowIntensity
ORDER BY exactNowIntensity DESC
LIMIT 25
```

To fully reset this project's Neo4j and Qdrant data:

```bash
bun run reset
```

To regenerate the benchmark JSON files:

```bash
bun run generate:benchmark
```

To run tests:

```bash
bun test
```

This project was created using `bun init` in bun v1.1.28. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
