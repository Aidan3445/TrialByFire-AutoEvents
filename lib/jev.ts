/**
 * Jev (TypeSafe System One) client.
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <JEV_API_KEY>
 *   { model, state, questions } -> { model, answers, usage }
 *
 * Requests over the context limit are split into several calls over the same
 * state and the answers merged. 429/529/5xx and network errors are retried
 * with exponential backoff.
 */

import type { JevResponse, Questions } from "./types/index.ts";

const URL = "https://api.typesafe.ai/v1/systemone";
// Documented limits are 64k tokens per request and 32k for state plus the
// longest question; stay under both with a rough 4-chars-per-token estimate
const MAX_REQUEST_TOKENS = 56_000;
const MAX_STATE_TOKENS = 28_000;
const tokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);

export interface JevUsage {
  requests: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
}

export interface JevClient {
  ask(state: unknown, questions: Questions): Promise<JevResponse>;
  readonly usage: JevUsage;
}

export interface JevOptions {
  apiKey: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createJevClient({ apiKey, model = "jev-latest", maxRetries = 6, timeoutMs = 60_000 }: JevOptions): JevClient {
  const usage: JevUsage = { requests: 0, retries: 0, inputTokens: 0, outputTokens: 0 };

  async function post(state: unknown, questions: Questions): Promise<JevResponse> {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let detail = "";
      try {
        const res = await fetch(URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, state, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        if (res.ok) {
          const body = (await res.json()) as JevResponse;
          usage.requests++;
          usage.inputTokens += body.usage?.input_tokens ?? 0;
          usage.outputTokens += body.usage?.output_tokens ?? 0;
          return body;
        }
        detail = (await res.text()).slice(0, 500);
      } catch (e) {
        detail = (e as Error).message;
      }
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= maxRetries) throw new Error(`Jev ${status || "network"} error: ${detail}`);
      usage.retries++;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random()));
    }
  }

  async function ask(state: unknown, questions: Questions): Promise<JevResponse> {
    const stateTokens = tokens(state);
    if (stateTokens > MAX_STATE_TOKENS) throw new Error(`state too large for Jev (~${stateTokens} tokens)`);
    const chunks: Questions[] = [{}];
    let size = stateTokens;
    for (const [key, q] of Object.entries(questions)) {
      const t = tokens({ [key]: q });
      if (size + t > MAX_REQUEST_TOKENS && Object.keys(chunks.at(-1)!).length) {
        chunks.push({});
        size = stateTokens;
      }
      chunks.at(-1)![key] = q;
      size += t;
    }
    const responses = await Promise.all(chunks.map((c) => post(state, c)));
    if (responses.length === 1) return responses[0];
    return {
      ...responses[0],
      answers: Object.assign({}, ...responses.map((r) => r.answers)),
      usage: {
        input_tokens: responses.reduce((n, r) => n + (r.usage?.input_tokens ?? 0), 0),
        output_tokens: responses.reduce((n, r) => n + (r.usage?.output_tokens ?? 0), 0),
      },
    };
  }

  return { ask, usage };
}
