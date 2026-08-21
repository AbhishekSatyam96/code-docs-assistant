# Code Docs Assistant

Point it at a GitHub repo (or a local folder), then ask questions about the
code. Answers come back with citations you can click through to the actual
lines.

<!-- Screenshots live in docs/screenshots/ -->

## Setup

You need Node 20.9+, an OpenAI key, and a Postgres with the `pgvector`
extension. A free Neon project is the easiest option; there's also a
`docker-compose.yml` with a local Postgres if you'd rather not sign up for
anything.

```bash
npm install
cp .env.example .env      # OPENAI_API_KEY + DATABASE_URL
npm run dev
```

There's no migration step. The app creates its own schema (`code_docs`) on
first connection, and it only ever touches that schema, so it can share a
database with something else.

```bash
npm test        # unit tests run anywhere; DB tests need TEST_DATABASE_URL
npm run check   # typecheck + lint + test
npm run eval    # retrieval quality report, costs a few cents
```

Config lives in one file, [`src/lib/config.ts`](src/lib/config.ts) — chunk
size, top-k, the RRF constant, context budget. They're together because those
are the knobs you actually sweep when you're trying to improve retrieval, and
hunting for them across six files is miserable.

Only `OPENAI_API_KEY` and `DATABASE_URL` are required. `GITHUB_TOKEN` is worth
setting if you deploy: one ingestion costs one API call against GitHub's
60/hour *per-IP* anonymous budget, which is plenty from your laptop but shared
with strangers on serverless. It's also the only way to index private repos.

## Architecture

```
Browser  ──POST(NDJSON stream)──►  Next.js route handlers
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
              INGEST                            QUERY
              fetch tarball                     triage    (gpt-4o-mini: intent
              filter files                        │        + rewrite + keywords)
              chunk                             retrieve  ├─ pgvector HNSW
              embed                               │       └─ tsvector + GIN
              build repo map                      │       fuse with RRF
                    │                           answer    (gpt-4o, streamed)
                    │                             │
                    └──────────►  Postgres  ◄─────┘
                       repositories · files · chunks · traces
```

One rule I stuck to: route handlers hold no logic. `/api/chat` validates,
rate-limits, and turns an async generator into bytes. That's it. The actual
pipeline is a plain `async function*` in
[`src/lib/llm/answer.ts`](src/lib/llm/answer.ts) that yields typed events,
which is why the eval harness could reuse it without going near HTTP.

```
src/
├── app/            routes + 4 API handlers
├── components/     UI
├── lib/
│   ├── config.ts       every tunable
│   ├── db/             pool, schema bootstrap, query helpers
│   ├── ingest/         sources → filter → chunk → repo map
│   ├── retrieval/      hybrid search, RRF, query builder
│   ├── llm/            prompts, answer pipeline
│   ├── guardrails/     triage, rate limiting
│   └── observability/  logging, traces
└── eval/           golden dataset + scoring
```

## The RAG bits

### Chunking

This is where most of the thinking went, because code doesn't chunk like prose.

A 700-token sliding window cuts a function in half roughly half the time. You
end up retrieving a signature with no body, or a body with no signature, and
then the model guesses. For a tool whose whole job is explaining code that's
the worst possible failure.

tree-sitter is the right answer and I didn't use it. It needs a WASM runtime
plus a grammar per language, and anything unsupported silently degrades to
nothing. What I did instead: per-language regexes find lines that *begin* a
declaration, the span between two boundaries is treated as atomic, and those
units get packed greedily into chunks. Only a unit too big to fit alone gets
split, with line overlap.

So a chunk boundary almost always lands on a declaration, small helpers get
grouped instead of each becoming a lonely 20-token chunk, and about 30
languages work. It's worse than a real parse and it's the first thing I'd
replace.

Every chunk gets a header before it's embedded:

```
File: src/lib/retrieval/fusion.ts
Language: typescript
Symbol: reciprocalRankFusion
Lines: 26-48

<the code>
```

Two reasons. A chunk from `src/api/auth/login.ts` now matches "login API" even
if the body never says "login". And the model sees the path inline, so it cites
accurately instead of inferring a filename.

The exclusion rules matter more than any of this. One `node_modules` slipping
through buries the real code under tens of thousands of junk chunks and
retrieval falls apart. Same rules run client-side before upload and server-side
as the actual boundary.

### The repo map

Retrieval is bad at whole-repo questions, and the brief asks for exactly those.
"What endpoints does this expose?" has no single chunk that answers it. "What
are the dependencies?" retrieves an import statement instead of the manifest.

So at ingest time I precompute a digest and inject it into every prompt:
language breakdown, directory tree, parsed dependency manifests, entry points,
and HTTP routes detected across Express/FastAPI/Flask/Spring/Django/Rails/Next.

This was the single biggest quality jump in the project and it costs one pass
over files already in memory. Route detection is regex-based so it's a
high-recall hint list, not a guarantee, and the prompt says so — the model
treats it as a lead to verify rather than gospel. On Express it reports 120
routes, most from the test suite. That's what a pattern matcher does to a repo
that *is* a routing library.

### Retrieval, and the result I didn't expect

Dense vectors (pgvector HNSW, cosine) plus Postgres full-text (`tsvector` +
GIN), fused with Reciprocal Rank Fusion:

```
score(d) = Σ  1 / (60 + rank(d))
```

RRF instead of a weighted blend because cosine and text rank aren't on the same
scale, and BM25-style scores shift with corpus statistics. You'd need
per-corpus normalisation and a weight retuned per repo. RRF throws away
magnitudes and keeps ordering, which is the part that transfers.

Two details worth more than they look:

The text search config is `simple`, not `english`. English stemming collapses
`parse`/`parser`/`parsing` into one token and drops `in`, `to`, `not`, all of
which are real identifiers. `simple` just lowercases. That pushes stopword
removal to the query side, which is where camelCase splitting happens anyway,
so "auth middleware" finds `authMiddleware`.

Neighbour expansion: code is sequential in a way prose isn't. A retrieved
function usually needs the imports above it. The top third of hits pull in
their adjacent chunks, which fixed the "explains the call but not the callee"
problem.

**And then the eval told me hybrid isn't helping.** Run against this repo's own
`src/` (40 files, 115 chunks, 18 questions):

| k | hybrid | vector | keyword |
|---|---|---|---|
| 3 | 83.3% / 0.769 | **94.4% / 0.861** | 61.1% / 0.519 |
| 10 | 100% / 0.806 | **100% / 0.880** | 83.3% / 0.550 |

Dense alone beats the fusion at every k. That's the opposite of what I built it
for, and it's the most useful thing the eval produced.

The mechanism makes sense once you look at it. RRF rewards agreement. A chunk
both retrievers rank 5th and 6th scores `1/65 + 1/66 = 0.031`, while a chunk
only the good retriever finds at rank 1 scores `1/61 = 0.016`. So mediocre
consensus beats a confident correct answer, and the weak retriever's mistakes
get promoted.

I haven't ripped hybrid out, for three reasons, and the first two are
criticisms of my measurement rather than defences of the design:

1. The corpus is 115 chunks of one TypeScript project where nearly every file
   talks about "chunk", "query", "retrieval". IDF has nothing to work with.
   Best case for dense, near-worst for lexical.
2. 13 of 18 questions are semantic, and all 3 lexical ones pass in every mode,
   so they contribute no signal at all. The queries where lexical search
   actually wins — a rare identifier, a literal error string — aren't in there.
3. Tuning weights against 18 questions is fitting noise.

Same result showed up on the original SQLite/FTS5 backend too, which is a
completely different lexical implementation. Two independent implementations
agreeing is harder to wave away. Weighted RRF is the obvious next move, but I
want a bigger and more balanced question set before I trust any conclusion.

### Models and storage

| | Choice | Why |
|---|---|---|
| Answering | `gpt-4o` | 4.1 reads unfamiliar code better, but 4o works on every account. A reviewer cloning this shouldn't hit "model not found". One env var to change. |
| Triage | `gpt-4o-mini` | Classification and rewriting. ~20x cheaper, adds ~300ms. |
| Embeddings | `text-embedding-3-small` | Voyage's code model is genuinely better and would be my production pick, but it's a second API key for whoever runs this. |
| Storage | Postgres + pgvector | One database for metadata, vectors *and* full-text, so hybrid retrieval is two queries against one system. No dual-write, no consistency gap. |
| Orchestration | none | See below. |

I didn't use LangChain. It would have saved maybe an hour on retriever glue and
cost me the ability to explain what happens between question and answer. The
pipeline is about 150 lines of explicit control flow. For a tool whose entire
value is trustworthy grounding, pointing at the exact line where context gets
assembled matters more than the boilerplate saved. I did take the genuinely
reusable things off the shelf: a tokenizer, the SDK, the vector extension.

Two pgvector details that cost me real time. `vector_cosine_ops` has to pair
with `<=>`; query with `<->` and Postgres silently ignores the index and
sequential-scans everything, so you get a correct-but-slow answer, which is the
kind of bug that reaches production. And filtered search under-returns: HNSW
knows nothing about `repo_id`, so Postgres filters *after* walking the index.
Ask for 30 candidates and you might get 3. `hnsw.iterative_scan` exists for
exactly this.

**This started on SQLite + `sqlite-vec`**, which was right for a single-node
prototype: one file, no daemon, integration tests running the real engine in a
temp dir in 300ms. It moved because a file on local disk can't back a
serverless deploy. What that migration actually cost is written up below.

### Prompts and context

System prompt order is deliberate: role, grounding rules, citation contract,
injection boundary, then style. Grounding and citations go first because
they're the rules the model drops when context gets long.

Retrieved code is capped at 12,000 tokens, enforced by walking the fused list
and stopping. Conversation history is replayed as plain text without its source
blocks — re-sending every earlier turn's code would blow the budget after four
questions and let stale excerpts outweigh fresh ones.

Query rewriting is what makes follow-ups work. "And where's that called?"
embeds to nothing useful; "Where is `validateSession` called?" retrieves fine.
I originally had classification, rewriting, and keyword extraction as three
calls, which meant three round trips of dead latency before retrieval even
started. They take the same input and produce small structured output, so
they're one `gpt-4o-mini` call with a JSON schema now.

### Guardrails

The interesting threat is prompt injection *from the indexed code*, and it
isn't hypothetical when you ingest arbitrary repos. A repo can contain a
comment addressed to an AI, or a fake system message in a test fixture. So
every excerpt is wrapped in delimited `<source>` blocks and the system prompt
has an explicit boundary: content inside is data to describe, never
instructions. Noticing such content is framed as an interesting finding to
report.

The rest: zod validation everywhere, intent classification that refuses
off-topic questions before retrieval runs, a token-bucket rate limiter,
SSRF protection (only `github.com` is fetchable), path traversal checks, size
caps, binary sniffing, and a citation-or-abstain instruction so "not in the
indexed code" is a valid answer.

Triage fails open on purpose. If the classifier errors you lose query
rewriting, not the product. The real safety boundary is the answering prompt,
which is grounded regardless.

### Quality

`npm run eval` indexes a directory and scores 18 questions across three
retrieval modes. It runs against this repo's own source, so it's reproducible
with no fixtures and no upstream drift.

Metrics are file-level, not chunk-level, because chunk boundaries move whenever
you tune the chunker and that would make numbers incomparable across exactly
the changes you're evaluating. Recall@k plus MRR, since recall alone can't see
the difference between ranking the right file 1st and 10th.

The eval found two bugs in itself, which is the argument for building one.
First run scored lexical search at 0.352 MRR, and the printed misses showed it
retrieving `eval/dataset.ts` — I was indexing the answer key, so every question
matched it verbatim. Later a trace showed the query as
`how | view | engine | render`, which is how I found that the identifier
heuristic counted any capital letter as evidence, so every sentence-initial
"How" bypassed the stopword list.

Neither bug was visible in an aggregate score. Both were obvious the moment the
harness printed its misses and the trace printed the query it actually ran.

**Testing:** 66 tests. The one I'd point at is
[`tests/pipeline.integration.test.ts`](tests/pipeline.integration.test.ts),
which runs the real pipeline against real Postgres and pgvector with only the
OpenAI calls stubbed. Pure functions aren't where this breaks. The seams are:
pgvector's text cast, the generated `tsvector`, `bigint` arriving as a string
from `pg`, the neighbour self-join.

There's also a test for embedding concurrency, because parallel batches that
reassemble out of order would attach every chunk's vector to a *different*
chunk. Retrieval would still run and be completely wrong. I broke the ordering
deliberately to confirm the test catches it.

### Observability

Structured JSON logs on stdout, one object per line, which is what CloudWatch
and friends want. `logger.bind({ traceId })` gives a child logger so ids flow
through without threading them into every signature. No pino; it's twenty
lines.

Every question writes a trace row: the question, the rewrite, intent, retrieved
chunk ids **with fusion scores and which retriever found each**, split timings,
tokens, cost. There's a UI panel over it, because when an answer is wrong the
question is always "what did retrieval actually return?" and that needs to be
readable next to the bad answer. It turns "the model hallucinated" into
"retrieval never returned that file", which are different bugs.

A real trace, Express, "how does routing work":

| | |
|---|---|
| retrieval | 336 ms |
| generation | 7.5 s |
| tokens | 10,085 in / 500 out |
| cost | $0.032 |

Two things I only learned by looking at that. Retrieval isn't the latency
problem, generation is; optimising the vector index would be work on 2% of the
wall clock. And the repo map is a large, completely static share of those 10k
prompt tokens, which makes prompt caching an obvious unimplemented win.

## Other decisions worth explaining

**NDJSON, not SSE.** This endpoint streams four event shapes (status, sources,
delta, done). SSE means re-encoding structured payloads as strings on both
ends, and `EventSource` can't POST, which matters because the question and
history belong in a body.

**Sources render before the answer.** They arrive a second ahead of the first
token, so you get something real to read while it generates and can see what
the answer is being built from.

**The citation drawer shows the whole file**, not just the retrieved slice. A
citation is only trustworthy if you can check it, and seeing the surrounding
code is usually how you notice the model over-read a fragment.

**One dark theme, committed to.** Two half-finished themes is worse than one
finished one.

## Productionising

Honestly: this is a well-engineered single-node app that happens to deploy to
Vercel. The RAG design carries over. The infrastructure mostly doesn't.

**The index already moved off local disk.** Postgres with pgvector, HNSW for
dense, generated `tsvector` + GIN for lexical. The app holds no local state.

What that migration cost, since "just move it to Postgres" reads as free:

- Every database call became async. `better-sqlite3` is synchronous and the
  whole call graph assumed it, including a server component rendering the repo
  list inline.
- Round trips replaced function calls. Two loops that were fine in-process
  became pathological over a network: one INSERT per chunk, one query per
  neighbour lookup. Both are batched now.
- `BIGINT` arrives as a string from `pg`. Coerced once in the row mapper rather
  than scattering `Number()` everywhere.
- Search went from ~16 ms to ~900 ms. Looks alarming next to the old number,
  irrelevant next to 8 s of generation.
- Zero-setup testing is gone. Integration tests need a real Postgres and skip
  unless `TEST_DATABASE_URL` is set. That's a genuine regression, traded for
  testing the same engine production uses.

**Ingestion needs a real queue.** It currently runs as a detached promise kept
alive by `after()`. That's enough for serverless but it dies with the process,
can't be retried, and can't be observed across replicas. Production shape:
`POST /api/repos` writes a row and publishes to SQS/Cloud Tasks; workers scale
separately because ingestion is bursty and network-bound while serving is
IO-bound. Then incremental re-indexing off a content hash per file, because
re-embedding a monorepo when one file moved is the cost that kills these
systems.

**There's no auth at all.** Deliberate for a take-home. Production needs SSO, a
`tenant_id` on every table with row-level security, per-tenant spend caps, and
GitHub tokens in a secrets manager rather than env vars.

**On AWS** I'd run: ECS Fargate behind an ALB for web, a separate Fargate
service consuming SQS for ingestion workers, Aurora Serverless v2 with pgvector,
S3 for source cache, Secrets Manager, ElastiCache for distributed rate limits
and an embedding cache, CloudWatch + OpenTelemetry, GitHub Actions → ECR → blue/green.

Cloudflare is a genuinely interesting alternative — Workers + D1 + Vectorize +
R2 maps almost one-to-one and would be far cheaper at low volume. The blocker
is CPU limits: chunking and embedding a large repo doesn't fit one invocation.

**Cost and reliability work I'd do:** prompt caching on the repo map (it's
byte-identical per repo), an embedding cache keyed by content hash, per-tenant
spend caps enforced before the call, circuit breakers around OpenAI with a
smaller-model fallback, and a read replica so the trace queries can't degrade
serving.

**Eval in CI**, failing the build on a recall regression, plus an LLM-judge pass
on answer faithfulness. That last one is the metric that actually correlates
with trust and I don't have it.

## Deploying to Vercel

It runs on Vercel. Four things were needed.

**Background indexing had to be kept alive.** `POST /api/repos` returns 202 and
indexes in the background, which is fine on a long-lived server and fatal on
serverless where the instance gets frozen the moment the response is written.
`after()` from `next/server` fixes it and is a no-op self-hosted, so one code
path serves both.

**`maxDuration = 60`** on that route (Hobby's ceiling; 300 on Pro). `after()`
doesn't grant unlimited time, it's bounded by this.

**Ingestion had to get about twice as fast.** Express took ~45 s against Neon
in another region, which leaves no margin under a 60 s limit. Almost all of it
was latency and payload, not compute:

- Batched file inserts. 176 files × 2 statements ≈ 350 round trips ≈ 28 s of
  pure latency. Now: chunk everything in memory, then multi-row INSERT.
- Parallel embedding calls. Five independent requests serialised by a `for`
  loop. Measured 7.5 s → 3.1 s at concurrency 4.
- Rounded vector literals. pgvector stores **float4**, so full float64 text
  shipped ~19 characters per dimension and Postgres discarded most of them. A
  438-chunk repo was uploading 12.9 MB of vector text. Eight decimals halves it.
- Split the embedding writes. 384 vectors per UPDATE was a 5 MB statement.

**45 s → 27 s.** The rounding was the one that could plausibly hurt quality, so
I checked instead of assuming: dense retrieval scored 94.4% / 0.861 before and
after, identical, exactly as float4 precision predicts.

This is still a ceiling, not a fix. A repo several times Express's size will
blow through 60 s. The queue is the real answer.

**`output: "standalone"` must not be set on Vercel** — it's right for Docker
and wrong here, so `next.config.ts` keys it off the `VERCEL` env var.

Set `OPENAI_API_KEY`, `DATABASE_URL` (the **pooled** Neon endpoint), and
ideally `GITHUB_TOKEN`. Don't set `TEST_DATABASE_URL`; its absence is what stops
the integration tests reaching a real index.

Still wrong on Vercel, being explicit: no auth, so anyone with the URL sees
every indexed repo and every question asked. Rate limiting is per-instance and
resets on cold start. And Neon scales to zero, so the first query after idle
takes an extra second.

## Engineering standards

**Kept:** strict TypeScript with no `any` in app code; zod at every trust
boundary; route handlers own no logic; `import "server-only"` so server modules
can't leak into the client bundle, with shared wire types in a neutral module;
66 tests including one over the real storage engine; structured logging with
correlation ids; comments that explain *why* and record rejected alternatives;
secrets only via env; non-root container user; one place for tunables.

**Skipped on purpose:**

- No auth. Out of scope, called out above.
- **The container setup is unverified.** Docker was never installed on the dev
  machine, so `Dockerfile` and `docker-compose.yml` have never been built.
  Static checks pass; that isn't the same thing. Since it deploys to Vercel this
  cost nothing to leave unproven, but it's a claim I haven't earned.
- No CI. `npm run check` runs everything; wiring it to Actions is ten minutes
  I'd rather have spent on retrieval.
- No component tests. Logic worth testing lives in `lib/`. I'd add Playwright
  for the ingest→ask→cite flow before React Testing Library.
- No migrations, just `CREATE TABLE IF NOT EXISTS` under an advisory lock. Fine
  for one schema owner, wrong the moment there's a second environment.
- Accessibility is partial: focus rings, aria-labels, escape-to-close,
  reduced-motion. No full audit, no screen reader testing.

## How I used AI tools

I used Claude Code heavily. The thing I care about is that the output looks
like code I'd have written, not like generated code.

What worked:

**Deciding the hard things first.** Chunking strategy, hybrid + RRF, the repo
map, Postgres over a dedicated vector store, no orchestration framework. Those
were decisions made before generating anything, and the AI implemented against
them. Reverse that order and you get a LangChain chain you can't debug.

**Probing instead of trusting recall.** Before writing either storage layer I
ran a ten-line script against it. Against `sqlite-vec` that turned up
better-sqlite3 binding JS numbers as REAL, which `vec0` rejects for rowids.
Against Neon it confirmed pgvector 0.8, which is what makes the filtered-search
fix available. Both would have been baffling three hours later; both took
thirty seconds up front.

**Reading version-specific docs.** Next.js 16 ships its own docs in
`node_modules` and had breaking changes newer than most training data.

**Tests as the check.** Writing chunker tests found a real overlap-stride bug.
Two other tests failed initially and it was my test setup that was wrong, not
the implementation, which is worth distinguishing before you "fix" working code.

My don'ts:

- Don't let it choose the architecture. It reaches for the most-blogged pattern,
  not the most appropriate one.
- Don't accept code you can't explain. Every non-obvious decision here has a
  comment saying why; if I couldn't write that comment, the code didn't stay.
- Don't trust "it works" without running it. Every layer got executed, including
  driving the real UI against a mocked OpenAI backend.
- Don't let it write the reasoning. Implementation is delegable; judgement isn't.

What keeps it repeatable: tunables in one file, the why-not-what comment rule,
the layering rule, and the eval. The eval especially — it's the difference
between "this feels better" and "recall went from 0.72 to 0.81". It's also what
told me my hybrid retrieval assumption was wrong.

## What I'd do next

1. **Settle hybrid vs dense properly.** 60–80 questions over a large
   multi-language repo with a real share of rare-identifier queries, then
   compare equal-weight RRF, weighted RRF, and dense alone. Whichever wins
   should win on data, not on the argument I found convincing while coding.
2. **Faithfulness eval.** Does every claim trace to a cited chunk? That's the
   metric that correlates with trust and it's the biggest gap here.
3. **tree-sitter chunking.** Weakest part of the pipeline, and a real parse
   unlocks a symbol graph.
4. **A symbol index.** Make "where is X called?" an exact lookup instead of a
   similarity search. Highest-value feature I didn't build — it's the question
   developers ask most.
5. Prompt caching on the repo map. Job queue + incremental re-indexing. A
   cross-encoder reranker, which would probably beat any fusion tweak.

## Known limitations

Acknowledged, not handled:

- The eval set is too small and too semantic-heavy to settle the hybrid
  question. 18 questions, 115 chunks, and the lexical ones carry no signal.
- Test files crowd out implementation. On Express most top hits for a routing
  question came from `test/`. Not wrong exactly, but you usually want
  `lib/router/index.js` first. A rank penalty is the obvious fix; I haven't
  added it because my eval can't currently measure whether it helps.
- Regex chunk boundaries misfire inside string literals and can't see nesting.
- Route detection produces false positives from test files and misses
  dynamically registered routes.
- English-centric stopwords.
- No incremental re-indexing; re-adding a repo re-embeds everything.
- Large repos hit the 3,000-file cap silently instead of warning.
- Rate limiting doesn't survive a restart or coordinate across replicas.
- Whole file contents are stored to render citations, which roughly doubles
  index size. Fine now, wrong at 10,000 repos.
- Chat history lives in browser memory and is lost on reload. Traces persist;
  the conversation doesn't.
