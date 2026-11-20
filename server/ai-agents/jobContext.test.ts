// The job's abort signal reaching real agent requests. The OpenAI SDK is real;
// only fetch is replaced, so nothing leaves the machine.
import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeContext } from "./latestKnowledgeAgent.js";
import { runInJob, pause, isCancellation, JobCancelledError, requestOptions } from "./jobContext.js";

process.env.OPENAI_API_KEY ??= "test-key"; // agents refuse to start without one

const realFetch = globalThis.fetch;

interface Sent {
  url: string;
  signal?: AbortSignal | null;
}

/**
 * A fetch that never answers on its own: each request stays open until its
 * signal aborts, like a slow OpenAI call.
 */
function hangingFetch(sent: Sent[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), signal: init?.signal });
    return new Promise((_, reject) => {
      const signal = init?.signal;
      const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
}

/**
 * If the job's signal ever stops reaching the SDK, the hanging request would
 * otherwise sit on the SDK's 10-minute default timeout. Cap it so that
 * regression fails within seconds instead.
 */
function failFast<T>(agent: T): T {
  const client = (agent as unknown as { openai: { timeout: number; maxRetries: number } }).openai;
  client.timeout = 3000;
  client.maxRetries = 0;
  return agent;
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out");
};

beforeEach(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("job scope", () => {
  test("requests made outside a job carry no signal (e.g. the news preview route)", () => {
    assert.deepEqual(requestOptions(), {});
  });

  test("each job sees only its own signal", async () => {
    const a = new AbortController();
    const b = new AbortController();
    const seen: AbortSignal[] = [];
    await Promise.all([
      runInJob("a", a.signal, async () => { await pause(5); seen[0] = requestOptions().signal!; }),
      runInJob("b", b.signal, async () => { await pause(1); seen[1] = requestOptions().signal!; }),
    ]);
    assert.equal(seen[0], a.signal);
    assert.equal(seen[1], b.signal);
  });

  test("the pause between articles ends as soon as the job is cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = runInJob("job", controller.signal, () => pause(10_000));
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(run, JobCancelledError);
    assert.ok(Date.now() - started < 1000, "did not wait out the pause");
  });
});

describe("real agents", () => {
  test("a knowledge request is aborted by the cancel, rejects as a cancellation and is not retried", async () => {
    const sent: Sent[] = [];
    globalThis.fetch = hangingFetch(sent); // before the agent builds its OpenAI client
    const { LatestKnowledgeAgent } = await import("./latestKnowledgeAgent.js");
    const agent = failFast(new LatestKnowledgeAgent());
    const controller = new AbortController();

    const run = runInJob("job", controller.signal, () => agent.gatherLatestKnowledge("WebGPU"));
    await until(() => sent.length === 1);
    assert.ok(sent[0].url.includes("/chat/completions"));
    assert.equal(sent[0].signal?.aborted, false);

    controller.abort();
    const error = await run.then(() => null, (e) => e);
    assert.ok(error, "the agent did not swallow the cancel into its fallback result");
    assert.ok(isCancellation(error), `expected a cancellation, got ${error?.name}: ${error?.message}`);
    assert.equal(sent[0].signal?.aborted, true, "the in-flight request was aborted");

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1, "the SDK did not retry the aborted request");
  });

  test("an enhancement request is aborted rather than replaced by the agent's fallback", async () => {
    const sent: Sent[] = [];
    globalThis.fetch = hangingFetch(sent);
    const { EnhanceAgent } = await import("./enhanceAgent.js");
    const agent = failFast(new EnhanceAgent());
    const controller = new AbortController();
    const content = { title: "t", content: "c", summary: "s", tags: [], sources: [], codeSamples: [] };
    const review = { approved: false, qualityScore: 50, issues: [], suggestedFixes: [] };

    const run = runInJob("job", controller.signal, () => agent.enhanceContent(content as any, review as any));
    await until(() => sent.length === 1);
    controller.abort();
    const error = await run.then(() => null, (e) => e);
    assert.ok(error && isCancellation(error), "rejected as a cancellation");
    assert.equal(sent.length, 1);
  });

  test("a custom post request is aborted rather than replaced by the placeholder post", async () => {
    const sent: Sent[] = [];
    globalThis.fetch = hangingFetch(sent);
    const { ContentAgent } = await import("./contentAgent.js");
    const agent = failFast(new ContentAgent({ getPosts: async () => [] }));
    const controller = new AbortController();
    const knowledge: KnowledgeContext = {
      topic: "WebGPU",
      currentInformation: "info",
      keyFindings: ["k"],
      recentDevelopments: ["d"],
      authorativeSources: [],
      technicalDetails: "t",
      industryTrends: "i",
      practicalApplications: "p",
    };

    const run = runInJob("job", controller.signal, () => agent.generateCustomBlogPost("WebGPU", undefined, knowledge));
    await until(() => sent.length === 1);
    controller.abort();
    const error = await run.then(() => null, (e) => e);
    assert.ok(error && isCancellation(error), "rejected as a cancellation, not the 'Understanding WebGPU' placeholder");
    assert.equal(sent.length, 1);
  });

  test("the same agents still work normally outside a cancelled job", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "q1\nq2" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const { LatestKnowledgeAgent } = await import("./latestKnowledgeAgent.js");
    const agent = failFast(new LatestKnowledgeAgent());
    const controller = new AbortController();
    const result = await runInJob("job", controller.signal, () => agent.gatherLatestKnowledge("WebGPU"));
    assert.equal(result.topic, "WebGPU");
  });
});
