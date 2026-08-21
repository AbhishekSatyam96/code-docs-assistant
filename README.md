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
- [Deploying to Vercel](#deploying-to-vercel)
- [Engineering standards](#engineering-standards-kept-and-skipped)
- [How I used AI tools](#how-i-used-ai-tools)
- [What I'd do next](#what-id-do-next)
- [Known limitations](#known-limitations)

---

## Quick start

Requires Node 20.9+, an OpenAI API key, and a Postgres database with the
`pgvector` extension (>= 0.8). A free [Neon](https://neon.tech) project works;
so does the local Postgres in `docker-compose.yml`.

```bash
npm install
cp .env.example .env      # add OPENAI_API_KEY and DATABASE_URL
npm run dev
```

The app creates its own schema (`code_docs` by default) on first connection —
no migration step, and nothing outside that schema is touched, so it can share
a database with another project.

Open http://localhost:3000, paste a GitHub URL (or pick a local folder), wait
for indexing, and start asking.

Everything else:

```bash
npm test          # unit tests need nothing; integration tests need TEST_DATABASE_URL
npm run typecheck
npm run lint
npm run check     # all three
npm run eval      # retrieval quality report (needs an API key, costs a few cents)
```

With Docker — brings up Postgres + pgvector alongside the app, so it needs no
external database:

```bash
OPENAI_API_KEY=sk-... docker compose up --build
```

### Configuration

`OPENAI_API_KEY` and `DATABASE_URL` are required. The interesting knobs:

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_ANSWER_MODEL` | `gpt-4o` | See [model choices](#model-and-infrastructure-choices) for why not 4.1 |
| `OPENAI_UTILITY_MODEL` | `gpt-4o-mini` | Query rewriting + intent classification |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Changing this rebuilds the vector index |
| `DATABASE_URL` | — | **Required.** Postgres with pgvector >= 0.8 (Neon, Supabase, RDS, local) |
| `DATABASE_SCHEMA` | `code_docs` | Own schema, so the app can share a database without owning `public` |
| `GITHUB_TOKEN` | — | Raises GitHub's 60/hr anonymous limit; allows private repos. Effectively required on Vercel — see [deploying](#deploying-to-vercel) |
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
│   ↓             │  │ 2. retrieve      ├─ dense KNN   (pgvector HNSW)│
│ chunk (AST-ish) │  │                  └─ full-text   (tsvector)    │
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
│  Postgres + pgvector (one schema)                                   │
│  repositories · files · traces                                      │
│  chunks — content, embedding vector(1536), generated tsvector       │
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
│   ├── db/                 pool, schema bootstrap, query helpers
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

**Why both retrievers — the argument.** Embeddings capture intent ("how do we
authenticate users") but are weak on rare literal tokens: an exact identifier
like `parseJwtPayload`, an error string, or an env var name gets averaged into
a generic "auth-ish" vector. BM25 nails those and is useless for paraphrase.
Developer questions are a mix of both, so running only one should lose a chunk
of them.

That was the reasoning. **My own eval does not currently support it** — dense
retrieval alone beats the fusion on this corpus. I've left the numbers and the
analysis in [Quality and evaluation](#quality-and-evaluation) rather than
quietly dropping the claim, because working out *why* is more interesting than
the result.

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

1. **The text search configuration is `simple`, not `english`.** `english`
   stems and strips stopwords, which is right for prose and wrong for code: it
   collapses `parsing`/`parser`/`parse` into one token and discards `in`, `to`
   and `not` — all of which are real identifiers. `simple` only lowercases.
   The cost is that stopword removal has to move to the query side, which
   [`fts-query.ts`](src/lib/retrieval/fts-query.ts) does along with camelCase
   splitting, so "auth middleware" matches `authMiddleware` and a pasted
   `getUserById` matches prose about "get user by id".

   The identifier heuristic behind that splitting is worth one more sentence,
   because I got it wrong: it originally counted *any* uppercase letter as
   evidence of an identifier, which made every sentence-initial capital one.
   "How does the view engine render?" therefore searched for `how` — exempting
   the most common word in English from the stopword list. It surfaced in a
   trace as `how | view | engine | render`. Evidence is now an *interior* case
   change, `_`/`$`/`.`, or SCREAMING_CASE.

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
| **Vector store** | pgvector, Qdrant, Chroma, LanceDB, SQLite + `sqlite-vec` | **Postgres + pgvector** | See below. |
| **Orchestration** | LangChain, LlamaIndex, **none** | **None** | See below. |

**Why Postgres + pgvector.** One database holds metadata, chunk text, the
vectors *and* the full-text index, so hybrid retrieval is two queries against
one system rather than a fan-out across a vector service and a relational one —
no dual-write, no consistency window where a chunk exists in one and not the
other. `vector(1536)` with an HNSW index over `vector_cosine_ops` handles the
dense half; a `STORED` generated `tsvector` column with a GIN index handles the
lexical half. And because the app holds no local state, it scales horizontally
and deploys to anything serverless.

> **This started as SQLite + `sqlite-vec`**, and that was the right call for a
> single-node prototype: one file, no daemon, and an integration test that ran
> the real storage engine in a temp directory in ~300ms. It moved to Postgres
> for a concrete reason — a file on local disk cannot back a serverless
> deployment, where the filesystem is ephemeral and per-instance. The section
> on [productionising](#productionising-this) describes the migration that this
> now *is*, and [what it cost](#what-the-migration-actually-cost) is written up
> honestly rather than presented as a free win.

**Two details specific to pgvector that took real reading:**

1. **The operator class is load-bearing.** `vector_cosine_ops` pairs with the
   `<=>` operator. Query with `<->` (L2) or `<#>` (inner product) and Postgres
   does not error — it silently ignores the index and sequential-scans every
   row. The failure mode is a correct but slow answer, which is exactly the
   kind of bug that survives to production.

2. **Filtered search under-returns.** An HNSW index knows nothing about
   `repo_id`, so Postgres walks the index in distance order and discards
   non-matching rows *afterwards*. Ask for 30 candidates and the scan can
   surface 30 rows that all belong to a different repository, leaving you with
   three. Still correct, silently degraded, and it gets worse as more repos are
   indexed. pgvector 0.8's `hnsw.iterative_scan = 'strict_order'` exists for
   this: when the filter eats the candidate set, keep scanning.

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

#### Results — and the assumption they falsified

Run against this repo's own `src/` (40 files → 115 chunks, 18 questions), on
Postgres:

| k | hybrid recall / MRR | **vector** recall / MRR | keyword recall / MRR |
|---|---|---|---|
| 3 | 83.3% / 0.741 | **94.4% / 0.861** | 66.7% / 0.546 |
| 10 | 94.4% / 0.778 | **100% / 0.880** | 83.3% / 0.585 |

**Dense retrieval alone beats the hybrid, at every k.** That is the opposite of
what I assumed when I built it, and it is the single most useful thing the eval
told me.

It is also the *second* time this result has appeared. The same table on the
original SQLite backend — a completely different sparse retriever, FTS5's BM25
rather than Postgres's `ts_rank_cd` — put vector ahead by a near-identical
margin (88.9%/0.806 hybrid vs 94.4%/0.880 vector at k=3). Two independent
lexical implementations reaching the same conclusion is much harder to dismiss
as an artifact of one of them.

*Why it happens.* RRF rewards agreement between retrievers, and that is exactly
the problem when one of them is weaker. A chunk both retrievers rank mediocrely
— 5th and 6th — scores `1/65 + 1/66 = 0.0306`. A chunk only the dense retriever
finds, at rank 1, scores `1/61 = 0.0164`. So a mediocre consensus outranks a
confident correct answer, and the sparse retriever's errors get promoted.

*Why I have not ripped hybrid out anyway.* Three reasons, and I want to be
clear that the first two are criticisms of my measurement, not defences of the
design:

1. **The corpus is too homogeneous to test lexical search fairly.** 115 chunks
   from a single TypeScript project where nearly every file discusses "chunk",
   "query", "retrieval", "embed". IDF has almost nothing to discriminate on.
   This is the best case for dense and close to the worst case for sparse.
2. **The question set is semantic-heavy and its lexical questions are too
   easy.** 13 of 18 are `semantic`; all 3 `lexical` questions pass in *every*
   mode, so they contribute no signal at all. The queries where BM25 actually
   wins — a rare identifier appearing in two chunks, a literal error string, an
   env var name — are absent. That is a flaw in my dataset.
3. **Tuning on 18 questions would be overfitting.** I could weight the fusion
   until hybrid won this table. That would be fitting noise, and I would learn
   nothing.

The honest position: *on a small homogeneous corpus, fusion costs you ranking
quality.* Whether it pays off on a large heterogeneous repo is untested, and I
would want a bigger, lexically balanced set on a real multi-language codebase
before either keeping or removing it. Weighted RRF (down-weighting the sparse
list) is the obvious fix and is at the top of [what I'd do next](#what-id-do-next).

*Two bugs this found.* The first run scored keyword at 0.352 MRR, and the
printed misses showed it retrieving `eval/dataset.ts` — the file containing the
golden questions. I was indexing the answer key, so every question matched it
verbatim; excluding the eval directory fixed it. Later, a trace showed the
lexical query as `how | view | engine | render`, which is how I found that the
identifier heuristic was treating every sentence-initial capital as a symbol
and exempting it from the stopword list.

Worth stating plainly: **my first set of numbers was wrong**, and the only
reason I know that is that the harness prints its misses and the traces print
the query they actually ran. Neither bug was visible in an aggregate score.

**Testing.** 59 tests, no API key required.

The one I'd point at is
[`tests/pipeline.integration.test.ts`](tests/pipeline.integration.test.ts): it
runs the real ingestion pipeline against real Postgres with real pgvector,
stubbing only the OpenAI calls. The parts most likely to break aren't the pure
functions — they're the seams: pgvector's text-literal cast on both the write
and read paths, the generated `tsvector` column, `ANY($1::bigint[])` array
binding, `BIGINT` arriving as a string, and the neighbour self-join. None of
that is exercised by unit tests and all of it fails loudly here.

It runs only when `TEST_DATABASE_URL` is set — deliberately a *separate*
variable from `DATABASE_URL`, so a stray `npm test` can never point at a real
index — and each run creates and drops its own randomly named schema.

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

**A trace per question**, persisted in Postgres: the question, the rewritten
question, intent, retrieved chunk ids *with their fusion scores and which
retriever found each*, split timings (embed / retrieval / LLM / total), token
counts, and computed cost.

**A UI panel** over those traces, because logs aren't enough for RAG. When an
answer is wrong the question is always "what did retrieval actually return?",
and that has to be inspectable next to the bad answer rather than reconstructed
from stdout. It turns "the model hallucinated" into "retrieval never returned
that file" — different bugs, different fixes.

#### What the traces say in practice

A representative real run — `expressjs/express` (176 files, 438 chunks), asked
*"How does routing work? Walk me through what happens when a request comes in."*

| | |
|---|---|
| retrieval | 336 ms |
| generation | 7.5 s |
| end to end | 13.8 s |
| prompt / completion tokens | 10,085 / 500 |
| cost | $0.032 |

Two things I only learned by looking at this:

1. **Retrieval is not the latency problem — the prompt is.** 336 ms of search
   against 7.5 s of generation. Optimising the vector index would be effort
   spent on 2% of the wall clock.
2. **The repo map is a large and completely static share of those 10k prompt
   tokens.** It is byte-identical for every question about a given repo, which
   makes prompt caching an obvious, unimplemented win — worth roughly 90% of
   the input cost on repeat questions. That is why it is on the next-steps list
   rather than in the "nice to have" pile.

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

### 1. The index has moved off local disk — done

This was the top item on this list, and it is now the shipped design: Postgres
with pgvector, HNSW for the dense half, a generated `tsvector` + GIN for the
lexical half. The app holds no local state, so it runs behind a load balancer
or on a serverless platform without a volume.

#### What the migration actually cost

Worth writing down, because "just move it to Postgres" reads as free and is not:

- **Every database call became `async`.** `better-sqlite3` is synchronous, and
  the whole call graph assumed it — including a server component that rendered
  the repository list inline. That ripple is most of the diff.
- **Round trips replaced function calls.** Two loops that were fine in-process
  became pathological over a network: one `INSERT` per chunk, and one query per
  neighbour lookup. Both are now single batched statements — a multi-row
  `VALUES` list with `RETURNING id`, and a self-join. On a 3,000-chunk repo the
  naive version would have spent minutes purely on latency.
- **`BIGINT` arrives as a string.** `pg` does that to avoid precision loss past
  2^53. Every id crossing the boundary is coerced once, in the row mapper,
  rather than scattering `Number()` through the codebase.
- **Retrieval got slower, and that is fine.** Search went from ~16 ms (SQLite,
  in-process) to ~900 ms against Neon in another region. It looks alarming next
  to the old number and is irrelevant next to the ~8 s the answer model takes.
- **Zero-setup testing is genuinely lost.** The integration test used to run the
  real engine in a temp file with no configuration. It now needs a real
  Postgres and is skipped unless `TEST_DATABASE_URL` is set. That is a real
  regression in developer experience, bought in exchange for testing the same
  engine production uses.

At genuinely large scale (10⁷+ vectors, many tenants) I'd move vectors to a
dedicated store — Qdrant, Vertex AI Vector Search, or Azure AI Search — and
keep Postgres for metadata. I would not start there.

### 2. Ingestion has to become a real job queue

Today indexing runs as a detached promise in the request process, kept alive
past the response by [`after()`](https://nextjs.org/docs/app/api-reference/functions/after).
That is enough to make it work on a serverless host — see
[Deploying to Vercel](#deploying-to-vercel) — but it dies with the process,
can't be retried, and can't be observed across replicas. This is the single
biggest gap.

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
low volume. The blocker is no longer storage — it is that Workers' CPU limits
don't suit chunking and embedding a large repo inside one invocation, so
ingestion would have to be split across invocations regardless.

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

---

## Deploying to Vercel

The app runs on Vercel as-is. Four things were needed to get there, and each is
worth knowing because they are the parts a "just push it" deploy gets wrong.

### 1. Background indexing has to be kept alive

`POST /api/repos` returns `202` immediately and indexes in the background. On a
long-lived server that just works. On a serverless host the instance can be
frozen or reclaimed the moment the response is written, which kills indexing
part-way and leaves a repository stuck in `indexing` forever.

The fix is `after()` from `next/server`, which runs a callback once the response
is sent while keeping the invocation alive:

```ts
const started = await startIngestion(input);
after(() => started.done);
return NextResponse.json({ id: started.id }, { status: 202 });
```

It is a no-op when self-hosted — that process was never going to be frozen — so
one code path serves both.

### 2. `maxDuration` bounds the whole thing

`after()` does not grant unlimited time; the callback is bounded by the route's
`maxDuration`. `/api/repos` sets **60 s**, which is the ceiling on Vercel's
Hobby plan. On Pro you can raise it to 300.

That number is a real constraint, not a formality — which is why the next
section exists.

### 3. Ingestion had to get roughly twice as fast

Indexing `expressjs/express` (176 files → 438 chunks) originally took **~45 s**
against Neon in `ap-southeast-1`. With a 60 s ceiling that leaves no margin, and
a larger repository simply fails. Profiling found the time was almost entirely
network latency and payload size, not compute:

| Fix | What it was | Why it was slow |
|---|---|---|
| **Batch file inserts** | One `INSERT` per file, interleaved with chunking | 176 files × 2 statements ≈ 350 round trips ≈ 28 s of pure latency. Now: chunk everything in memory, then multi-row `INSERT … RETURNING id, path`. |
| **Parallel embedding calls** | Five sequential OpenAI requests | Independent requests serialised by a `for` loop. Now four in flight (`INGEST.embeddingConcurrency`). Measured: 7.5 s → 3.1 s. |
| **Round vector literals** | Full float64 text | pgvector stores **float4**, so ~19 characters per dimension went over the wire and most were discarded on arrival. A 1536-dim literal is 29 KB; a 438-chunk repo shipped **12.9 MB** of vector text. Eight decimal places halves it. |
| **Split embedding writes** | 384 vectors per `UPDATE` | A single ~5 MB statement. Now 64 rows (~1 MB), which streams and pipelines far better. |

Result: **45 s → 27 s**, with real headroom under the Hobby limit.

The rounding is the one that could plausibly have hurt quality, so it was
checked rather than assumed: `npm run eval` scored dense retrieval at
**94.4% recall@3 / 0.861 MRR both before and after** — identical, exactly as
float4's precision predicts.

**This is still a ceiling, not a solution.** A repository several times the size
of Express will exceed 60 s and fail. The honest fix is the job queue in the
section above; everything here just buys enough room for realistic inputs.

### 4. `output: "standalone"` must not be set on Vercel

It is right for the Docker image and wrong for Vercel, which supplies its own
build adapter. `next.config.ts` keys it off the `VERCEL` environment variable so
one config serves both targets.

### Environment variables

| Variable | Notes |
|---|---|
| `OPENAI_API_KEY` | Required. |
| `DATABASE_URL` | Required. **Use Neon's pooled endpoint** — the host containing `-pooler`. The direct endpoint has a connection ceiling that N serverless instances × 3 connections will find. |
| `DATABASE_SCHEMA` | Optional, defaults to `code_docs`. |
| `GITHUB_TOKEN` | **Effectively required on Vercel.** GitHub's anonymous limit is 60 requests/hour *per IP*, and serverless egress IPs are shared — so the quota is often already spent by someone else. Locally this is genuinely optional. |

Do **not** set `TEST_DATABASE_URL` in Vercel; it exists only to let the
integration tests run, and its absence is what keeps them from touching a real
index.

### What is still wrong on Vercel

Being explicit, because these are properties of the deployment rather than bugs:

- **No auth.** Anyone with the URL sees every indexed repository, can read any
  file through `/api/files`, and can see every question and its cost. Fine
  behind a preview URL you control; not fine public.
- **Rate limiting is per-instance.** The token bucket lives in process memory,
  so it resets on every cold start and does not coordinate across instances.
  It protects against a runaway tab, not against abuse. Redis (Upstash) is the
  fix.
- **Cold starts pay for schema bootstrap.** The first request after an idle
  period takes the advisory lock and runs the `CREATE … IF NOT EXISTS` pass.
  It is idempotent and fast, but it is not free.
- **Neon scales to zero.** After inactivity the first query wakes the compute,
  adding a second or two. Expected, and invisible once warm.

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
  path against Postgres. Fine for a single schema owner, wrong the moment
  there is a second environment — that needs a real migration chain, which the
  sibling project does with `prisma migrate deploy`.
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
  the repo map, the storage engine, no orchestration framework — these were
  decisions made before generating code, and the AI implemented against them.
  Reversing that order is how you end up with a LangChain chain you can't debug.
- **Verifying assumptions with throwaway probes instead of trusting recall.**
  Before writing either storage layer I ran a ten-line script against it first.
  Against `sqlite-vec` that found that better-sqlite3 binds JS numbers as REAL
  and `vec0` rejects them for rowids. Against Neon it confirmed pgvector 0.8.1
  — which is what makes `iterative_scan` available, and the filtered-search
  recall fix depends on it. Both are bugs that would have been baffling three
  hours later and were thirty seconds to find up front.
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

1. **Settle the hybrid-vs-dense question properly.** My eval says fusion is
   currently costing me ranking quality, but the eval is too small and too
   semantic-heavy to be the last word. Concretely: build a 60–80 question set
   over a large multi-language repo, with a real share of rare-identifier and
   error-string queries; then compare equal-weight RRF, weighted RRF, and dense
   alone. Whichever wins, I'd want it to win on data rather than on the
   argument I found convincing while writing the code.
2. **Faithfulness eval.** Retrieval recall is only half the quality story. An
   LLM-judge pass checking that every claim traces to a cited chunk is the
   metric that correlates with trust, and I don't have it.
3. **tree-sitter chunking.** The regex boundary detection is the weakest part
   of the pipeline. A real parse also unlocks a symbol graph.
4. **A symbol index.** Extract definitions and call sites into a table, and let
   "where is X called?" be an exact lookup instead of a similarity search. This
   is the highest-value feature I didn't build — it's the question developers
   actually ask most.
5. **Prompt caching for the repo map.** It's byte-identical across every
   question for a repo. Straightforward cost win.
6. **Job queue + incremental re-indexing** (see productionising).
7. **A reranker.** A cross-encoder over the top ~30 fused candidates would
   likely beat every parameter tweak I could make to fusion.
8. **Multi-repo questions**, and repo-to-repo comparison.
9. **Answer-level caching** keyed on (repo commit, normalised question).

---

## Known limitations

Acknowledged rather than handled:

- **The eval set is too small and too semantic-heavy** to settle the
  hybrid-vs-dense question: 18 questions over 115 chunks, of which the 3
  lexical ones pass in every mode and therefore carry no signal. See
  [Results](#results--and-the-assumption-they-falsified).
- **Test files crowd out implementation.** On `expressjs/express`, most of the
  top retrieved chunks for a routing question came from `test/`. Not strictly
  wrong — a test suite is a precise description of behaviour — but the user
  usually wants `lib/router/index.js` first. A rank penalty for `test/`,
  `spec/`, `__tests__/` is the obvious fix; I have not added it because my eval
  set cannot currently measure whether it helps or hurts.
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
- **Whole-file contents are stored** in Postgres to render citations, which
  roughly doubles index size. Fine at this scale; wrong at 10,000 repos.
- **No conversation persistence** — chat history is in browser memory and lost
  on reload. Traces persist; the conversation doesn't.
- **Binary/notebook formats** (`.ipynb`, protobuf descriptors) aren't parsed.
# code-docs-assistant
