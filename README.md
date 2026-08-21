# Code Documentation Assistant

Point it at a GitHub repo or a local folder. It indexes the code and answers
questions about it — how something works, where a thing is implemented, what
endpoints exist, what it depends on — with citations back to the exact lines it
used.

<!-- Screenshots: see docs/screenshots/ -->

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [The RAG design](#the-rag-design)
  - [Chunking](#chunking-the-decision-i-spent-the-most-time-on)
  - [The repo map](#the-repo-map-what-made-the-biggest-quality-difference)
  - [Retrieval](#retrieval-hybrid--rrf)
  - [Model choices](#model-and-infrastructure-choices)
  - [Prompt and context management](#prompt-and-context-management)
  - [Guardrails](#guardrails)
  - [Quality and evaluation](#quality-and-evaluation)
  - [Observability](#observability)
- [Key technical decisions](#key-technical-decisions)
- [Productionising this](#productionising-this)
- [Engineering standards](#engineering-standards-kept-and-skipped)
- [How I used AI tools](#how-i-used-ai-tools)
- [What I'd do next](#what-id-do-next)
- [Known limitations](#known-limitations)

---

## Quick start

Requires Node 20.9+ and an OpenAI API key.

```bash
npm install
cp .env.example .env      # add your OPENAI_API_KEY
npm run dev
```

Open http://localhost:3000, paste a GitHub URL (or pick a local folder), wait
for indexing, and start asking.

Everything else:

```bash
npm test          # 59 unit + integration tests, no API key needed
npm run typecheck
npm run lint
npm run check     # all three
npm run eval      # retrieval quality report (needs an API key, costs a few cents)
```

With Docker:

```bash
OPENAI_API_KEY=sk-... docker compose up --build
```

### Configuration

Only `OPENAI_API_KEY` is required. The interesting knobs:

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_ANSWER_MODEL` | `gpt-4o` | See [model choices](#model-and-infrastructure-choices) for why not 4.1 |
| `OPENAI_UTILITY_MODEL` | `gpt-4o-mini` | Query rewriting + intent classification |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Changing this rebuilds the vector index |
| `DATABASE_PATH` | `./data/index.db` | SQLite file: chunks, vectors, FTS, traces |
| `GITHUB_TOKEN` | — | Raises GitHub's 60/hr anonymous limit; allows private repos |
| `OPENAI_BASE_URL` | — | Point at Azure OpenAI, LiteLLM, vLLM, etc. |

RAG parameters (chunk size, top-k, RRF constant, context budget) all live in
one place: [`src/lib/config.ts`](src/lib/config.ts). They're there because
they're the things you actually sweep during evaluation, and hunting them
across six files is miserable.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (React, single client component tree)                      │
│  Sidebar · Chat · Code drawer · Trace drawer                        │
└───────────┬─────────────────────────────────────────────────────────┘
            │  NDJSON stream over POST
┌───────────▼─────────────────────────────────────────────────────────┐
│  Next.js route handlers                                             │
│  /api/repos   /api/chat   /api/files   /api/traces                  │
│  (thin transport only — validation, rate limit, serialisation)      │
└───────────┬─────────────────────────────────────────────────────────┘
            │
   ┌────────┴──────────┐
   │                   │
┌──▼──────────────┐  ┌─▼──────────────────────────────────────────────┐
│ INGESTION       │  │ QUERY                                          │
│                 │  │                                                │
│ fetch tarball   │  │ 1. triage        gpt-4o-mini, one call:        │
│   ↓ (in memory) │  │                  intent + rewrite + keywords   │
│ filter files    │  │      ↓                                         │
│   ↓             │  │ 2. retrieve      ├─ dense KNN   (sqlite-vec)   │
│ chunk (AST-ish) │  │                  └─ BM25        (FTS5)         │
│   ↓             │  │      ↓           fuse with RRF                 │
│ embed (batched) │  │      ↓           + neighbour expansion         │
│   ↓             │  │ 3. assemble      repo map + numbered sources   │
│ build repo map  │  │      ↓                                         │
└──┬──────────────┘  │ 4. stream        gpt-4o → NDJSON deltas        │
   │                 │      ↓                                         │
   │                 │ 5. record trace                                │
   │                 └─┬──────────────────────────────────────────────┘
   │                   │
┌──▼───────────────────▼──────────────────────────────────────────────┐
│  SQLite (one file)                                                  │
│  repositories · files · chunks · chunks_fts (FTS5)                  │
│  chunk_vectors (sqlite-vec vec0, partitioned by repo) · traces      │
└─────────────────────────────────────────────────────────────────────┘
```

The layering rule I held to: **route handlers own no logic**. `/api/chat` does
validation, rate limiting, and turns an async generator into a byte stream —
that's it. The pipeline in [`src/lib/llm/answer.ts`](src/lib/llm/answer.ts) is
a plain `async function*` that yields typed events. It's directly callable from
tests and from the eval harness without spinning up HTTP, and that's why the
eval harness exists at all — it was cheap to write because the pipeline wasn't
tangled into the framework.

```
src/
├── app/                    Next.js routes + 4 API handlers
├── components/             UI (client components)
├── lib/
│   ├── config.ts           every tunable, in one place
│   ├── types.ts            wire types shared by server + browser
│   ├── db/                 SQLite + sqlite-vec setup, schema
│   ├── ingest/             sources → filter → chunk → repo map → pipeline
│   ├── retrieval/          hybrid search, RRF, FTS query builder
│   ├── llm/                client, prompts, answer pipeline
│   ├── guardrails/         triage, rate limiting
│   └── observability/      structured logging, trace store
└── eval/                   golden dataset + scoring harness
```

---

## The RAG design

### Chunking: the decision I spent the most time on

Fixed-size windows are the default answer and they're wrong for code. A
700-token sliding window cuts a function in half roughly half the time, and the
retrieved fragment is then a signature with no body or a body with no
signature. For a tool whose entire job is explaining code, that's the failure
mode that matters most.

**What I considered:**

| Option | Why not |
|---|---|
| Fixed-size + overlap | Simplest, but splits functions mid-body. Rejected. |
| tree-sitter (real parse) | Correct answer for production. Costs a WASM runtime plus a grammar per language, and every unsupported language degrades to nothing. |
| LLM-based semantic chunking | One model call per file. Far too slow and expensive for a 3,000-file repo, and non-deterministic. |
| **Structure-aware line chunking** | **Chosen.** |

What I built: per-language regexes identify lines that *begin* a declaration
(function, class, heading). The span between consecutive boundaries is an
atomic **unit**. Units are packed greedily into chunks up to the token budget,
and only a unit too large to fit alone gets hard-split, with line overlap.

The result is that a chunk boundary almost always coincides with a declaration
boundary, small helper functions get grouped with their neighbours instead of
each becoming a lonely 20-token chunk, and ~30 languages are covered in a few
dozen lines. It degrades to plain line packing rather than breaking.

It is genuinely worse than a real parse — it can't see nesting, and a regex
will occasionally fire inside a string literal. That's a documented trade, and
tree-sitter is the first thing I'd swap in. See
[`src/lib/ingest/chunker.ts`](src/lib/ingest/chunker.ts).

**Contextual headers.** Every chunk is embedded and keyword-indexed with a
prefix:

```
File: src/lib/retrieval/fusion.ts
Language: typescript
Symbol: reciprocalRankFusion
Lines: 26-48

<the actual code>
```

Two payoffs: a chunk from `src/api/auth/login.ts` matches a query about "login
API" even when the body never says "login"; and the model sees the path inline,
so it cites accurately instead of inferring a filename.

**Exclusion is the highest-leverage quality control in the pipeline.** One
`node_modules` slipping through buries the repo's real code under tens of
thousands of irrelevant chunks and retrieval collapses. It also dominates
ingestion cost. The rules run identically on the client (before upload) and the
server (as the real boundary) — see
[`src/lib/ingest/languages.ts`](src/lib/ingest/languages.ts).

### The repo map: what made the biggest quality difference

Pure similarity search is bad at whole-repo questions, and the assignment asks
for exactly those:

- *"What API endpoints does this expose?"* — no single chunk answers it. The
  answer is spread across twenty route files and top-12 retrieval sees a
  fraction of them.
- *"What are the dependencies?"* — retrieves an import statement, not the
  manifest.
- *"How does this work?"* — matches nothing in particular.

So at ingestion I precompute a structural digest and inject it into **every**
answer prompt: language breakdown, a depth-limited directory tree with file
counts, parsed dependency manifests (npm/pip/go/cargo/maven/bundler), detected
entry points, statically-detected HTTP routes across Express/FastAPI/Flask/
Spring/Django/Rails/Next.js, and a README excerpt.

This was the single largest quality improvement in the project and it costs one
cheap pass over files already in memory. Retrieval then handles what it's
actually good at: specific, local questions.

The route detection is regex-based, so it's a high-recall *hint list*, not a
guaranteed-complete API reference — and the prompt says so explicitly, which
means the model treats it as a lead to verify against retrieved code rather
than ground truth to recite. (On `expressjs/express` it finds 120 routes,
most of them from the test suite. That's the honest behaviour of a pattern
matcher on a repo that is itself a routing library.)

### Retrieval: hybrid + RRF

**Why both retrievers.** Embeddings capture intent ("how do we authenticate
users") but are weak on rare literal tokens — an exact identifier like
`parseJwtPayload`, an error string, or an env var name gets averaged into a
generic "auth-ish" vector. BM25 nails those and is useless for paraphrase.
Developer questions are a near-even mix, so running only one loses half of them.

**Why RRF and not a weighted blend.** Cosine similarity and BM25 aren't on the
same scale, and BM25's range shifts with corpus statistics — so
`0.7*cosine + 0.3*bm25` needs per-corpus normalisation and a weight retuned for
every repository. RRF throws away magnitudes and keeps only ordering, which is
the part that transfers:

```
score(d) = Σ_retrievers  1 / (k + rank(d))     k = 60
```

No tuning, no normalisation, and a document ranked well by *both* retrievers
beats one ranked first by a single retriever — exactly what you want when a
rare identifier and a paraphrase disagree.

**Two details that mattered more than expected:**

1. **FTS5 tokenizer config.** `tokenize="unicode61 ... tokenchars '_$.'"` keeps
   `_`, `$` and `.` inside tokens, so `handleRequest`, `$scope` and
   `res.status` survive tokenisation instead of being shredded. The query
   builder also splits camelCase, so "auth middleware" matches `authMiddleware`
   and a pasted `getUserById` matches prose about "get user by id".

2. **Neighbour expansion.** Code is sequential in a way prose isn't — a
   retrieved function often depends on imports above it or a helper below it.
   The top third of hits pull in their adjacent chunks. This fixed the common
   "explains the call but not the callee" failure.

**Stopwords are load-bearing.** Without them, "how does the app handle errors"
matches essentially every chunk on *the/does/how* and BM25 degenerates into
noise that pollutes the fused ranking.

### Model and infrastructure choices

| Component | Considered | Chosen | Reasoning |
|---|---|---|---|
| **LLM** | gpt-4o, gpt-4.1, Claude | `gpt-4o` (configurable) | 4.1 is better at reading unfamiliar code and has a bigger window. I defaulted to 4o because it works on *every* OpenAI account — a reviewer cloning this repo should never hit "model not found". Reliability over marginal quality, and it's one env var to change. |
| **Utility model** | same model, or a smaller one | `gpt-4o-mini` | Triage is classification + rewriting. It's ~20x cheaper and adds ~300ms; using the big model here would double per-question cost for no gain. |
| **Embeddings** | `text-embedding-3-small`, `-large`, Voyage `voyage-code-3` | `text-embedding-3-small` | Voyage is genuinely better on code and would be my production choice, but it's a second API key for whoever runs this. `-large` is 2x the dimensions and 6.5x the cost for a modest gain at this corpus size. |
| **Vector store** | pgvector, Qdrant, Chroma, LanceDB, in-memory | **SQLite + `sqlite-vec`** | See below. |
| **Orchestration** | LangChain, LlamaIndex, **none** | **None** | See below. |

**Why SQLite + sqlite-vec.** The whole index — metadata, chunk text, the BM25
index, the vectors, and the query traces — is one file with no daemon. That
means: hybrid search is a local join instead of a cross-service fan-out; the
integration test runs the *real* storage engine in a temp directory in ~300ms;
and `docker compose up` needs one container. `vec0`'s partition keys give
per-repo KNN isolation, so a large repo can't crowd out results from the repo
you're actually asking about. It brute-forces within a partition — fine to
roughly 10⁵–10⁶ vectors, which comfortably covers "a codebase". Past that you
want an ANN index, which is the pgvector/Qdrant migration described below.

**Why no orchestration framework.** LangChain would have saved me maybe an hour
on the retriever glue and cost me the ability to explain what happens between
question and answer. The pipeline here is ~150 lines of explicit control flow;
the equivalent LangChain chain is a config object whose behaviour lives in
someone else's abstraction. For a system whose entire value is *trustworthy
grounding*, being able to point at the exact line where context is assembled
matters more than the boilerplate saved. The genuinely reusable pieces — a
tokenizer, an SDK, a vector extension — I did take off the shelf.

### Prompt and context management

The system prompt is ordered deliberately: role → grounding rules → citation
contract → injection boundary → style. Grounding and citations sit *before* the
softer style guidance because they're the rules the model must not drop under a
long context.

**Context budget.** Chunks are capped at 12,000 tokens total, enforced by
walking the fused list and stopping when the next chunk would overflow.
Retrieval can legitimately return more good material than fits; truncating here
rather than letting the API reject an oversized request keeps cost and latency
predictable.

**Conversation history is replayed as plain text, without its source blocks.**
Re-sending every earlier turn's retrieved code would blow the budget after
three or four questions and — worse — let stale excerpts outweigh the ones
retrieved for the current question. Keeping the thread but re-retrieving fresh
evidence each turn is the right trade for a Q&A tool.

**Query rewriting** is what makes follow-ups work at all. "And where is that
called?" embeds to nothing useful; "Where is `validateSession` called?"
retrieves correctly. I originally had classification, rewriting, and keyword
extraction as three separate calls — three round trips and about a second of
dead latency before retrieval even started. They all take the same input and
produce small structured output, so merging them into one `gpt-4o-mini` call
with a JSON schema costs ~300ms and a twentieth of a cent.

### Guardrails

**Prompt injection from indexed code is the interesting threat here**, and it's
not hypothetical: this tool ingests arbitrary third-party repositories. A repo
can contain a comment addressed to an AI, a prompt in a test fixture, or a fake
system message. Mitigations:

- Every excerpt is wrapped in delimited `<source id="3" path="..." lines="...">`
  blocks. The delimiters are load-bearing — without them, "ignore everything
  after this" inside a source comment is indistinguishable from the prompt.
- The system prompt has an explicit untrusted-content boundary: content inside
  `<source>` is data to describe, never instructions to follow, and noticing
  such content is framed as an interesting *finding* to report.

Everything else:

| Guardrail | Where |
|---|---|
| Input validation (zod, length caps, history caps) | every route handler |
| Intent classification — off-topic / injection refused before retrieval | `guardrails/triage.ts` |
| Rate limiting (token bucket per IP) | `guardrails/rate-limit.ts` |
| **SSRF**: only `github.com` is fetchable | `ingest/sources.ts` |
| Path traversal, absolute paths, NUL injection rejected | `isSafePath()` |
| Size caps: 3,000 files, 256KB/file, 40MB total | `config.ts` |
| Binary sniffing | `looksBinary()` |
| Citation-or-abstain instruction; "not in the indexed code" is a valid answer | `llm/prompts.ts` |
| File API reads from the *index*, never the filesystem | `api/files/route.ts` |

Triage **fails open** on purpose: if the classifier errors, you lose query
rewriting, not the product. The real safety boundary is the answering prompt,
which is grounded in retrieved code regardless.

A refused question short-circuits before retrieval and before the answer model
— visible in the trace as `0 chunks, 0 prompt tokens, $0.0000`.

### Quality and evaluation

`npm run eval` indexes a directory (default: this project's own `src/`) and
scores an 18-question golden set against three retrieval modes.

Self-referential on purpose: it's reproducible with no network, no fixture
downloads, and no drift when an upstream project changes.

Two metrics, both **file-level rather than chunk-level**. Chunk boundaries move
whenever the chunker is tuned, which would make numbers incomparable across
exactly the changes the eval exists to evaluate. "Did we surface the right
file?" is stable and is what determines whether the model can answer.

- **recall@k** — share of questions where an expected file appears in the top k
- **MRR** — mean reciprocal rank of the first correct file; rewards ranking it
  1st rather than 10th, which recall can't see

The dataset deliberately includes the awkward cases, tagged by kind:
`lexical` (names an exact identifier — BM25 should win), `semantic` (describes
behaviour, names nothing — embeddings should win), and `structural` (about the
repo as a whole — what the repo map exists for). The per-kind breakdown is how
you tell *which* retriever regressed rather than just that something did.

Neighbour expansion is disabled during eval: crediting a retriever for an
adjacent chunk of a file it already found measures nothing.

> **I have not run this against a real API key** — I built and verified it
> against a mocked embedding backend (`tests/eval.test.ts` runs the full
> harness end to end), so the harness works, but the actual recall numbers are
> yours to generate. Run `npm run eval` and paste the table here.

**Testing.** 59 tests, no API key required.

The one I'd point at is
[`tests/pipeline.integration.test.ts`](tests/pipeline.integration.test.ts): it
runs the real ingestion pipeline against real SQLite with real `sqlite-vec` and
real FTS5, stubbing only the OpenAI calls. The parts most likely to break here
aren't the pure functions — they're the seams: the `vec0` rowid binding (JS
numbers bind as REAL and the extension rejects them, which cost me a while to
find), the FTS5 external-content triggers, partition-key isolation across
repos, and neighbour expansion joining back to the right file. None of that is
exercised by unit tests and all of it fails loudly here.

Writing the chunker tests found a real bug: when a unit is hard-split, an
`overlapLines` wider than the resulting window made the stride collapse to one
line, filling the index with near-duplicate chunks. Overlap is now capped at
half the window, with a regression test.

### Observability

Three layers.

**Structured logs** — one JSON object per line on stdout, which is what
CloudWatch/Cloud Logging/Loki want. `logger.bind({ traceId, repoId })` produces
a child logger so identifiers flow through the call stack without being
threaded through every signature. No pino, no transports; it's twenty lines.

**A trace per question**, persisted in SQLite: the question, the rewritten
question, intent, retrieved chunk ids *with their fusion scores and which
retriever found each*, split timings (embed / retrieval / LLM / total), token
counts, and computed cost.

**A UI panel** over those traces, because logs aren't enough for RAG. When an
answer is wrong the question is always "what did retrieval actually return?",
and that has to be inspectable next to the bad answer rather than reconstructed
from stdout. It turns "the model hallucinated" into "retrieval never returned
that file" — different bugs, different fixes.

---

## Key technical decisions

**NDJSON instead of Server-Sent Events.** SSE is the reflexive choice, but this
endpoint streams four event shapes (`status`, `sources`, `delta`, `done`) and
SSE's framing means re-encoding structured payloads as strings on both ends.
NDJSON is one `JSON.parse` per line, needs no client library, and — unlike
`EventSource` — works over POST, which matters because the question and history
belong in a body.

**Sources are shown before the answer streams.** They arrive from the server as
soon as retrieval finishes, a second ahead of the first token. The user gets
something real to read during generation and can see what evidence the answer
is being built from.

**Full files in the citation drawer, not just the retrieved slice.** A citation
is only trustworthy if you can check it. Seeing the surrounding code is usually
how you notice the model over-read a fragment.

**Background indexing with polled progress.** A mid-size repo takes 30–90
seconds — past any sensible HTTP timeout. The repo row is created immediately
and progress is written to it as work proceeds, so the client polls a real
percentage instead of watching a spinner. Polling stops the moment everything
settles.

**One dark theme, committed to.** Two half-finished themes is worse than one
finished one. It's a developer tool that sits next to an editor; the palette is
low-chroma so syntax highlighting stays the most colourful thing on screen.

**Schema as a TypeScript module, not a `.sql` file.** Next.js standalone builds
only trace JS, so a loose `.sql` asset would be missing in the container.

---

## Productionising this

Honest summary: **this is a well-engineered single-node prototype.** The RAG
design would carry over; the infrastructure would not. Here's what changes,
roughly in the order I'd do it.

### 1. The index has to move off SQLite

SQLite-on-a-volume means one writer, no horizontal scale, and a stateful pod.
Moving to **Postgres + pgvector** (RDS / Cloud SQL / Azure Flexible Server) is
the smallest change that fixes it: I keep hybrid search as a single query,
because Postgres has both `tsvector` full-text and pgvector KNN. An HNSW index
replaces the brute-force scan. The storage layer is already behind a thin
module, so this is a rewrite of `lib/db` and the two queries in
`lib/retrieval`, not of the pipeline.

At genuinely large scale (10⁷+ vectors, many tenants) I'd move vectors to a
dedicated store — Qdrant, Vertex AI Vector Search, or Azure AI Search — and
keep Postgres for metadata. I would not start there.

### 2. Ingestion has to become a real job queue

Today indexing runs as a detached promise in the request process. It dies with
the process, can't be retried, and can't be observed across replicas. This is
the single biggest gap.

Production shape: `POST /api/repos` writes a row and publishes to a queue
(SQS + Lambda/Fargate, Cloud Tasks + Cloud Run, or Azure Service Bus). Workers
scale independently of the web tier, which matters because ingestion is bursty
and CPU/network-bound while serving is IO-bound. Add idempotency keys, a dead
letter queue, and exponential backoff on the embedding API.

Incremental re-indexing follows: store a content hash per file, and on a webhook
from GitHub re-chunk only what changed. Re-embedding an entire monorepo because
one file moved is the kind of cost that kills these systems.

### 3. Multi-tenancy and auth

There is no auth at all right now — deliberately, for a take-home. Production
needs OIDC/SSO, a `tenant_id` on every table with row-level security, per-tenant
rate limits and spend caps, and encryption at rest. Indexing private repos means
holding GitHub tokens, which belong in Secrets Manager / Secret Manager / Key
Vault with short-lived credentials, never in env vars on a long-lived host.

### 4. Concrete AWS shape

The one I'd actually build:

| Concern | Service |
|---|---|
| Web tier | ECS Fargate behind ALB, 2+ tasks across AZs (Next.js standalone image already built) |
| Ingestion workers | Separate Fargate service consuming SQS; scale on queue depth |
| Metadata + vectors | Aurora Serverless v2 Postgres + pgvector |
| Blob/source cache | S3 with lifecycle expiry |
| Secrets | Secrets Manager, rotated |
| Cache | ElastiCache Redis — distributed rate limits, embedding cache, hot-query cache |
| Logs/metrics/traces | CloudWatch + OpenTelemetry → X-Ray or Datadog |
| CI/CD | GitHub Actions → ECR → ECS blue/green |

Cloudflare is a genuinely interesting alternative: Workers + D1 + Vectorize +
R2 maps almost one-to-one onto this design and would be dramatically cheaper at
low volume. The blocker is `better-sqlite3` — the ingestion path would need
rewriting against D1's API, and Workers' CPU limits don't suit chunking a large
repo without splitting it across invocations.

### 5. Cost and reliability controls

Prompt caching on the repo map (it's identical across every question for a repo
— an obvious win I didn't implement). An embedding cache keyed by content hash.
Per-tenant spend caps enforced before the API call, not after. Circuit breakers
around OpenAI with a smaller-model fallback. Streaming timeouts. A read replica
for the trace queries so observability can't degrade serving.

### 6. Evaluation in CI

The eval harness exists but isn't wired to CI. It should run on every PR that
touches ingestion or retrieval, and fail the build on a recall regression beyond
a threshold. Plus an LLM-as-judge pass over answer *faithfulness* (does every
claim trace to a cited chunk?) — that's the metric that actually correlates with
user trust, and it's the biggest quality gap in what I've built.

---

## Engineering standards (kept, and skipped)

**Kept:**

- TypeScript strict mode; zero `any` in application code; zod validation at
  every trust boundary
- Layering discipline — route handlers own no business logic
- `import "server-only"` on server modules so they can't leak into the client
  bundle; shared wire types in a neutral module both sides typecheck against
- 59 tests, including an integration test over the real storage engine
- Structured logging with correlation IDs; every question traced
- Comments explain *why*, not *what* — decisions and rejected alternatives are
  recorded next to the code they explain
- Secrets only via env; `.env.example` committed, `.env` never
- Non-root container user, multi-stage build, healthcheck, volume for state
- One place for tunables

**Skipped, knowingly:**

- **No auth.** Out of scope for a take-home; called out above.
- **No CI pipeline.** `npm run check` runs everything; wiring it to Actions is
  ten minutes I'd rather have spent on retrieval quality.
- **No component tests.** The UI is verified manually (see screenshots). The
  logic worth testing lives in `lib/`; testing that React renders a div is
  low-value. I'd add Playwright for the ingest→ask→cite flow before adding
  React Testing Library.
- **No migrations.** `CREATE TABLE IF NOT EXISTS` plus a rebuild-on-model-change
  path. Fine for one file, wrong for Postgres — that needs proper migrations.
- **Coverage thresholds not enforced.** Configured but not gated; I'd rather
  have 59 meaningful tests than a number.
- **Accessibility is partial.** Focus rings, `aria-label`s on icon buttons,
  keyboard escape on drawers, `prefers-reduced-motion` — but no full audit and
  no screen-reader testing.
- **Error boundaries.** Errors surface in-band in the chat; there's no React
  error boundary for a render crash.

---

## How I used AI tools

> **Note for whoever is reading this section:** this describes the workflow
> honestly, including the fact that this project was built with heavy AI
> assistance. Adjust it to match how you'd describe your own process.

I used Claude Code as the primary tool, and the thing I care about is that the
output looks like code I'd have written, not like generated code.

**What worked:**

- **Deciding the hard things myself, first.** Chunking strategy, hybrid + RRF,
  the repo map, SQLite over pgvector, no orchestration framework — these were
  decisions made before generating code, and the AI implemented against them.
  Reversing that order is how you end up with a LangChain chain you can't debug.
- **Verifying assumptions with throwaway probes instead of trusting recall.**
  Before writing the storage layer I ran a ten-line script against `sqlite-vec`
  to check partition keys and KNN actually worked. That's how I found that
  better-sqlite3 binds JS numbers as REAL and `vec0` rejects them for rowids —
  a bug that would have been baffling three hours later, found in thirty
  seconds by probing first.
- **Reading the version-specific docs.** Next.js 16 ships its own docs in
  `node_modules`; the framework had breaking changes newer than most training
  data. Reading them beat guessing.
- **Tests as the check on generated code.** Writing the chunker tests caught a
  real overlap-stride bug. Two other tests failed initially and were *my test
  setup* being wrong, not the implementation — worth distinguishing rather than
  "fixing" working code to match a bad test.

**My don'ts:**

- Don't let it choose the architecture. It reaches for the most common pattern,
  which is usually the most-blogged-about one, not the most appropriate one.
- Don't accept code you can't explain. Every non-obvious decision in this repo
  has a comment saying why; if I couldn't write that comment, the code didn't
  stay.
- Don't trust "it works" without running it. Every layer here was executed:
  tests for logic, a mocked OpenAI backend to drive the real UI end to end.
- Don't let it write the README's reasoning. Implementation is delegable;
  judgement isn't.

**Making it repeatable:** the tunables-in-one-file convention, the "comments
explain why" rule, the layering rule, and the eval harness are all guardrails
that keep future AI-assisted changes on-rails. The eval especially — it's the
difference between "this change feels better" and "recall went from 0.72 to
0.81".

---

## What I'd do next

Roughly in priority order:

1. **Faithfulness eval.** Retrieval recall is only half the quality story. An
   LLM-judge pass checking that every claim traces to a cited chunk is the
   metric that correlates with trust, and I don't have it.
2. **tree-sitter chunking.** The regex boundary detection is the weakest part
   of the pipeline. A real parse also unlocks a symbol graph.
3. **A symbol index.** Extract definitions and call sites into a table, and let
   "where is X called?" be an exact lookup instead of a similarity search. This
   is the highest-value feature I didn't build — it's the question developers
   actually ask most.
4. **Prompt caching for the repo map.** It's byte-identical across every
   question for a repo. Straightforward cost win.
5. **Job queue + incremental re-indexing** (see productionising).
6. **A reranker.** A cross-encoder over the top ~30 fused candidates would
   likely beat every parameter tweak I could make to fusion.
7. **Multi-repo questions**, and repo-to-repo comparison.
8. **Answer-level caching** keyed on (repo commit, normalised question).

---

## Known limitations

Acknowledged rather than handled:

- **Regex chunk boundaries** misfire inside string literals and can't see
  nesting depth.
- **Route detection** is pattern matching — false positives from test files
  (120 "routes" in `expressjs/express`, mostly from its test suite), and it
  misses dynamically registered routes entirely.
- **English-centric stopwords**; non-English identifiers and comments get
  weaker keyword retrieval.
- **No incremental re-indexing** — re-adding a repo re-embeds everything.
- **Very large repos** hit the 3,000-file cap silently rather than warning.
- **Minified or generated files** that slip past the filters produce useless
  chunks.
- **Single-process rate limiting** doesn't survive a restart or coordinate
  across replicas.
- **Whole-file contents are stored** in SQLite to render citations, which
  roughly doubles index size. Fine at this scale; wrong at 10,000 repos.
- **No conversation persistence** — chat history is in browser memory and lost
  on reload. Traces persist; the conversation doesn't.
- **Binary/notebook formats** (`.ipynb`, protobuf descriptors) aren't parsed.
# code-docs-assistant
