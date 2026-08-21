import "server-only";

import OpenAI from "openai";
import { env } from "@/lib/config";

let client: OpenAI | null = null;

/**
 * Single shared OpenAI client.
 *
 * `maxRetries` covers 429s and 5xx with exponential backoff inside the SDK,
 * which is the correct layer for it — retrying at the route level would
 * re-run embedding and retrieval work that already succeeded.
 */
export function openai(): OpenAI {
  if (client) return client;
  client = new OpenAI({
    apiKey: env().OPENAI_API_KEY,
    baseURL: env().OPENAI_BASE_URL,
    maxRetries: 3,
    timeout: 60_000,
  });
  return client;
}
