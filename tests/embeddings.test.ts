import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Ordering under concurrency.
 *
 * `embedTexts` fans its batches out in parallel, and every caller depends on
 * `vectors[i]` corresponding to `texts[i]` — the ingestion pipeline zips the
 * results straight back onto chunk ids by position. Getting this wrong would
 * attach each chunk's embedding to a *different* chunk: retrieval would still
 * run, still return results, and be silently, thoroughly wrong.
 *
 * So the mock below finishes its batches in deliberately reversed order. A
 * naive `push`-as-they-resolve implementation passes the sequential tests and
 * fails this one.
 */

process.env.OPENAI_API_KEY = "test-key-not-used";
process.env.DATABASE_URL = "postgres://unused";

let created: string[][] = [];

vi.mock("@/lib/llm/client", () => ({
  openai: () => ({
    embeddings: {
      create: async ({ input }: { input: string[] }) => {
        created.push(input);
        // Later batches resolve FIRST. `created.length` is the 1-based batch
        // number, so batch 1 waits longest.
        const delay = Math.max(0, 40 - created.length * 8);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          data: input.map((text, index) => ({
            index,
            // Encode the source text in the vector so the assertion can prove
            // which input produced it.
            embedding: [Number(text.replace("chunk-", ""))],
          })),
          usage: { total_tokens: input.length },
        };
      },
    },
  }),
}));

type Embeddings = typeof import("@/lib/embeddings");
let embeddings: Embeddings;

beforeAll(async () => {
  embeddings = await import("@/lib/embeddings");
});

describe("embedTexts", () => {
  it("returns vectors in input order even when batches finish out of order", async () => {
    created = [];
    // 250 texts at a batch size of 96 → three batches, so the reversal matters.
    const texts = Array.from({ length: 250 }, (_, i) => `chunk-${i}`);

    const { vectors, tokens } = await embeddings.embedTexts(texts);

    expect(vectors).toHaveLength(250);
    expect(created.length).toBeGreaterThan(1); // genuinely batched
    expect(tokens).toBe(250);

    // The decisive assertion: vector i encodes text i.
    for (let i = 0; i < texts.length; i++) {
      expect(vectors[i][0], `vector at index ${i}`).toBe(i);
    }
  });

  it("caps how many requests are in flight at once", async () => {
    created = [];
    let inFlight = 0;
    let peak = 0;

    const { INGEST } = await import("@/lib/config");
    const client = await import("@/lib/llm/client");
    vi.spyOn(client, "openai").mockReturnValue({
      embeddings: {
        create: async ({ input }: { input: string[] }) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight--;
          return {
            data: input.map((_, index) => ({ index, embedding: [0] })),
            usage: { total_tokens: input.length },
          };
        },
      },
      // The real client has a far larger surface; this stub only needs the one
      // method the code under test calls.
    } as unknown as ReturnType<typeof client.openai>);

    // 20 batches' worth of input.
    await embeddings.embedTexts(
      Array.from({ length: INGEST.embeddingBatchSize * 20 }, (_, i) => `chunk-${i}`),
    );

    expect(peak).toBeLessThanOrEqual(INGEST.embeddingConcurrency);
    expect(peak).toBeGreaterThan(1); // actually concurrent, not accidentally serial
    vi.restoreAllMocks();
  });

  it("handles an empty input without calling the API", async () => {
    created = [];
    const result = await embeddings.embedTexts([]);
    expect(result).toEqual({ vectors: [], tokens: 0 });
    expect(created).toHaveLength(0);
  });
});
