# Screenshots

Capture these with a **real `OPENAI_API_KEY`** so the answers are genuine —
that matters more for a submission than a staged shot.

```bash
cp .env.example .env     # add your key
npm run dev
```

Index something with a bit of surface area — `expressjs/express`,
`tiangolo/fastapi`, or this repo itself — then capture:

| File | What to show |
|---|---|
| `01-overview.png` | Repo indexed: stat cards (language, routes, dependencies, entry points), language bar, suggested questions |
| `02-answer.png` | An answer mid- or post-stream, with the source strip and inline citation pills visible |
| `03-citation.png` | The code drawer open on a cited file, scrolled to the highlighted line range |
| `04-observability.png` | The trace drawer with a row expanded, showing retrieved chunks with `via` and score |
| `05-guardrail.png` | An off-topic question refused (trace shows `0 chunks · $0.0000`) |

Good questions for the answer shot:

- "What API endpoints does this expose, and what does each one do?"
- "How does routing work — walk me through a request?"
- "What are the main dependencies and what is each used for?"

Then reference them from the top of the root `README.md`:

```markdown
![Repository overview](docs/screenshots/01-overview.png)
![Answer with citations](docs/screenshots/02-answer.png)
```

If you record a video, `06-demo.mp4`: index a repo, ask two questions (one
structural, one "where is X implemented"), click a citation to open the drawer,
then open the observability panel. About 90 seconds.
