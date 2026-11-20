// Cancellation of AI generation jobs, end to end through the orchestrator,
// with scripted agents standing in for OpenAI. Each scripted step behaves like
// an SDK request: it honours the job's abort signal and can be held open so a
// test can cancel while it is in flight.
import { describe, test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { AIOrchestrator, type GenerationJob } from "./orchestrator.js";
import { currentJobSignal } from "./jobContext.js";

const userAbort = () => Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });

interface Gate {
  reached: Promise<void>;
  release: (value?: unknown) => void;
  fail: (error: Error) => void;
}

/** Records every agent step and lets a test hold any step open. */
class Script {
  steps: string[] = [];
  aborted: string[] = [];
  posts: string[] = [];
  private gates = new Map<string, { gate: Gate; resolveReached: () => void; wait: Promise<unknown>; ignoresAbort: boolean }>();
  private failures = new Map<string, Error>();

  /**
   * The next call to `step` waits until released, failed or aborted.
   * `ignoresAbort` models work that can't be interrupted and settles on its own.
   */
  hold(step: string, { ignoresAbort = false } = {}): Gate {
    let resolveReached!: () => void;
    let release!: (v?: unknown) => void;
    let fail!: (e: Error) => void;
    const reached = new Promise<void>((r) => (resolveReached = r));
    const wait = new Promise<unknown>((res, rej) => {
      release = res;
      fail = rej;
    });
    const gate = { reached, release, fail };
    this.gates.set(step, { gate, resolveReached, wait, ignoresAbort });
    return gate;
  }

  failWith(step: string, error: Error): void {
    this.failures.set(step, error);
  }

  async run<T>(step: string, value: T): Promise<T> {
    this.steps.push(step);
    const signal = currentJobSignal();
    if (signal?.aborted) {
      this.aborted.push(step);
      throw userAbort();
    }
    const failure = this.failures.get(step);
    if (failure) {
      this.failures.delete(step);
      throw failure;
    }
    const held = this.gates.get(step);
    if (!held) return value;
    this.gates.delete(step);
    held.resolveReached();
    if (held.ignoresAbort) {
      await held.wait;
      return value;
    }
    const aborted = new Promise<never>((_, reject) =>
      signal?.addEventListener("abort", () => {
        this.aborted.push(step);
        reject(userAbort());
      }, { once: true }),
    );
    await Promise.race([held.wait, aborted]);
    return value;
  }
}

const content = (title: string) => ({ title, content: "body ".repeat(300), summary: "s", tags: [], sources: [], codeSamples: [] });
const article = (id: string) => ({ id, title: id, source: "x", publishedAt: "", url: "", content: "", relevanceScore: 0.9, tags: [] });

function build(script: Script, opts: { approved?: boolean; articles?: number } = {}) {
  const approved = opts.approved ?? false;
  const articles = Array.from({ length: opts.articles ?? 2 }, (_, i) => article(`a${i + 1}`));
  const knowledge = { gatherLatestKnowledge: (topic: string) => script.run("knowledge", { topic }), model: "" };
  const news = {
    fetchLatestNews: () => script.run("fetchNews", articles),
    analyzeRelevance: (a: unknown[]) => script.run("analyze", a),
  };
  const contentAgent = {
    model: "",
    generateCustomBlogPost: (topic: string) => script.run("generate", content(topic)),
    generateMultipleBlogPosts: async (list: { title: string }[]) => {
      const out = [];
      for (const a of list) out.push(await script.run(`generate:${a.title}`, content(a.title)));
      return out;
    },
  };
  let reviews = 0;
  const review = {
    model: "",
    reviewContent: (c: { title: string }) => script.run(`review:${c.title}`, { approved, qualityScore: approved ? 95 : 60, issues: [], suggestedFixes: [], ...{ n: ++reviews } }),
  };
  const enhance = {
    model: "",
    enhanceContent: (c: { title: string }) => script.run(`enhance:${c.title}`, { enhancedContent: c, improvementsMade: [] }),
  };
  const storage = {
    createPost: async (p: { title: string }) => {
      await script.run(`save:${p.title}`, null);
      script.posts.push(p.title);
      return { id: `post-${p.title}` };
    },
    getTags: async () => [],
    createTag: async (t: object) => t,
  };
  return new AIOrchestrator(news as any, contentAgent as any, review as any, enhance as any, knowledge as any, storage as any);
}

const customJob = (o: AIOrchestrator, topic = "Rust") => o.startCustomGeneration({ topic, type: "custom" });
const newsJob = (o: AIOrchestrator, focusTopic?: string) =>
  o.startGeneration({ hoursBack: 24, minRelevanceScore: 0.5, maxArticles: 5, focusTopic });

/** Waits for the job's pipeline to stop; a pipeline that keeps running is a failure, not a hang. */
async function settled(o: AIOrchestrator, id: string, ms = 2000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`job ${id} was still running ${ms} ms after the test expected it to stop`)), ms);
  });
  try {
    await Promise.race([o.whenSettled(id), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Steps that ran after `step`, i.e. work started after the cancel. */
const after = (script: Script, step: string) => script.steps.slice(script.steps.indexOf(step) + 1);

beforeEach(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

describe("custom-topic jobs", () => {
  test("complete normally and save exactly one post", async () => {
    const script = new Script();
    const o = build(script);
    const id = await customJob(o);
    await settled(o, id);
    const job = o.getJob(id)!;
    assert.equal(job.status, "completed");
    assert.equal(job.results?.postId, "post-Rust");
    assert.deepEqual(script.posts, ["Rust"]);
    assert.deepEqual(script.steps, ["knowledge", "generate", "review:Rust", "enhance:Rust", "save:Rust"]);
  });

  test("a genuine error still fails the job and keeps its message", async () => {
    const script = new Script();
    script.failWith("generate", new Error("model overloaded"));
    const o = build(script);
    const id = await customJob(o);
    await settled(o, id);
    const job = o.getJob(id)!;
    assert.equal(job.status, "failed");
    assert.equal(job.error, "model overloaded");
    assert.deepEqual(script.posts, []);
  });

  for (const step of ["knowledge", "generate", "review:Rust", "enhance:Rust"]) {
    test(`cancelling during ${step} aborts that request, starts nothing after it and saves no post`, async () => {
      const script = new Script();
      const gate = script.hold(step);
      const o = build(script);
      const id = await customJob(o);
      await gate.reached;

      const result = o.cancelJob(id);
      assert.equal(result.outcome, "cancelled");
      assert.equal(o.getJob(id)!.status, "cancelled", "reported as cancelled straight away");

      await settled(o, id);
      const job = o.getJob(id)!;
      assert.equal(job.status, "cancelled");
      assert.equal(job.error, undefined, "a cancel is not an error");
      assert.ok(job.cancelledAt);
      assert.deepEqual(script.aborted, [step], "the in-flight request was aborted");
      assert.deepEqual(after(script, step), [], "no later step started");
      assert.deepEqual(script.posts, []);
    });
  }

  test("a step that can't be interrupted and finishes after the cancel is not followed by a save", async () => {
    const script = new Script();
    const gate = script.hold("enhance:Rust", { ignoresAbort: true });
    const o = build(script);
    const id = await customJob(o);
    await gate.reached;
    o.cancelJob(id);
    gate.release(); // the enhancement result arrives anyway
    await settled(o, id);
    assert.equal(o.getJob(id)!.status, "cancelled");
    assert.deepEqual(after(script, "enhance:Rust"), [], "its result was discarded and nothing was saved");
    assert.deepEqual(script.posts, []);
  });

  test("an error that arrives after the cancel does not turn it into a failure", async () => {
    const script = new Script();
    const gate = script.hold("review:Rust", { ignoresAbort: true });
    const o = build(script);
    const id = await customJob(o);
    await gate.reached;
    // A request that ignores the abort and fails on its own afterwards.
    const job = o.getJob(id)!;
    o.cancelJob(id);
    gate.fail(new Error("socket hang up"));
    await settled(o, id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.error, undefined);
    assert.deepEqual(after(script, "review:Rust"), [], "nothing ran after it");
  });

  test("a cancel that lands while the post is being saved keeps the job cancelled and reports the post", async () => {
    const script = new Script();
    const gate = script.hold("save:Rust", { ignoresAbort: true });
    const o = build(script);
    const id = await customJob(o);
    await gate.reached;
    o.cancelJob(id);
    gate.release(); // the insert itself is not abortable and finishes
    await settled(o, id);
    const job = o.getJob(id)!;
    assert.equal(job.status, "cancelled");
    assert.deepEqual(script.posts, ["Rust"]);
    assert.equal(job.results?.postId, "post-Rust", "the post that was saved is not lost");
  });
});

describe("news jobs", () => {
  test("complete normally and save one post per relevant article", async () => {
    const script = new Script();
    const o = build(script);
    const id = await newsJob(o, "agents");
    await settled(o, id);
    const job = o.getJob(id)!;
    assert.equal(job.status, "completed");
    assert.deepEqual(job.results?.postIds, ["post-a1", "post-a2"]);
  });

  test("no relevant articles is still a failure", async () => {
    const script = new Script();
    const o = build(script, { articles: 0 });
    const id = await newsJob(o);
    await settled(o, id);
    assert.equal(o.getJob(id)!.status, "failed");
    assert.equal(o.getJob(id)!.error, "No articles met the relevance criteria");
  });

  const stages = ["knowledge", "fetchNews", "analyze", "generate:a1", "generate:a2", "review:a1", "enhance:a1"];
  for (const step of stages) {
    test(`cancelling during ${step} aborts it, starts nothing after it and saves no post`, async () => {
      const script = new Script();
      const gate = script.hold(step);
      const o = build(script);
      const id = await newsJob(o, "agents");
      await gate.reached;
      o.cancelJob(id);
      await settled(o, id);
      assert.equal(o.getJob(id)!.status, "cancelled");
      assert.deepEqual(script.aborted, [step]);
      assert.deepEqual(after(script, step), []);
      assert.deepEqual(script.posts, []);
    });
  }

  for (const step of ["analyze", "review:a1", "enhance:a1"]) {
    test(`a ${step} step that finishes after the cancel is discarded: nothing later runs and nothing is saved`, async () => {
      const script = new Script();
      const gate = script.hold(step, { ignoresAbort: true });
      const o = build(script);
      const id = await newsJob(o);
      await gate.reached;
      o.cancelJob(id);
      gate.release();
      await settled(o, id);
      assert.equal(o.getJob(id)!.status, "cancelled");
      assert.deepEqual(after(script, step), []);
      assert.deepEqual(script.posts, []);
    });
  }

  test("cancelling during the second post's review keeps the first post and creates no more", async () => {
    const script = new Script();
    const gate = script.hold("review:a2");
    const o = build(script);
    const id = await newsJob(o);
    await gate.reached;
    o.cancelJob(id);
    await settled(o, id);
    const job = o.getJob(id)!;
    assert.equal(job.status, "cancelled");
    assert.deepEqual(script.posts, ["a1"]);
    assert.deepEqual(job.results?.postIds, ["post-a1"]);
    assert.deepEqual(after(script, "review:a2"), []);
  });

  test("a cancel during one post's save stops before the next post is reviewed", async () => {
    const script = new Script();
    const gate = script.hold("save:a1", { ignoresAbort: true });
    const o = build(script);
    const id = await newsJob(o);
    await gate.reached;
    o.cancelJob(id);
    gate.release();
    await settled(o, id);
    const job = o.getJob(id)!;
    assert.equal(job.status, "cancelled");
    assert.deepEqual(script.posts, ["a1"]);
    assert.deepEqual(job.results?.postIds, ["post-a1"]);
    assert.ok(!script.steps.includes("review:a2"), "the next post was not reviewed");
  });

  test("a cancel during the last post's save still ends cancelled, not completed", async () => {
    const script = new Script();
    const gate = script.hold("save:a2", { ignoresAbort: true });
    const o = build(script);
    const id = await newsJob(o);
    await gate.reached;
    o.cancelJob(id);
    gate.release();
    await settled(o, id);
    const job = o.getJob(id)!;
    assert.equal(job.status, "cancelled");
    assert.deepEqual(job.results?.postIds, ["post-a1", "post-a2"]);
  });
});

describe("cancel requests", () => {
  test("an unknown job is not_found", () => {
    assert.deepEqual(build(new Script()).cancelJob("nope"), { outcome: "not_found" });
  });

  test("a finished job cannot be cancelled and keeps its outcome", async () => {
    const script = new Script();
    const o = build(script);
    const id = await customJob(o);
    await settled(o, id);
    const result = o.cancelJob(id);
    assert.equal(result.outcome, "already_finished");
    assert.equal(o.getJob(id)!.status, "completed");
  });

  test("cancelling twice: the second request is already_finished with status cancelled", async () => {
    const script = new Script();
    const gate = script.hold("generate");
    const o = build(script);
    const id = await customJob(o);
    await gate.reached;
    assert.equal(o.cancelJob(id).outcome, "cancelled");
    const second = o.cancelJob(id);
    assert.equal(second.outcome, "already_finished");
    assert.equal(second.outcome === "already_finished" && second.job.status, "cancelled");
    await settled(o, id);
  });

  test("cancelling one job leaves another running job untouched", async () => {
    const script = new Script();
    const gateA = script.hold("generate");
    const o = build(script);
    const a = await customJob(o, "Alpha");
    await gateA.reached;
    // Job B is held at its own step while A is cancelled.
    const gateB = script.hold("generate");
    const b = await customJob(o, "Beta");
    await gateB.reached;

    o.cancelJob(a);
    await settled(o, a);
    assert.equal(o.getJob(b)!.status, "generating", "B is still running");

    gateB.release();
    await settled(o, b);
    assert.equal(o.getJob(a)!.status, "cancelled");
    assert.equal(o.getJob(b)!.status, "completed");
    assert.deepEqual(script.aborted, ["generate"], "only A's request was aborted");
    assert.deepEqual(script.posts, ["Beta"]);
  });

  test("stats count cancelled jobs separately from failures", async () => {
    const script = new Script();
    const o = build(script);
    const done = await customJob(o);
    await settled(o, done);

    script.failWith("generate", new Error("boom"));
    const failed = await customJob(o);
    await settled(o, failed);

    const gate = script.hold("generate");
    const cancelled = await customJob(o);
    await gate.reached;
    o.cancelJob(cancelled);
    await settled(o, cancelled);

    const stats = o.getStats();
    assert.equal(stats.totalJobs, 3);
    assert.equal(stats.completedJobs, 1);
    assert.equal(stats.failedJobs, 1);
    assert.equal(stats.cancelledJobs, 1);
  });

  test("the job record exposes a distinct cancelled status in the job list", async () => {
    const script = new Script();
    const gate = script.hold("knowledge");
    const o = build(script);
    const id = await customJob(o);
    await gate.reached;
    o.cancelJob(id);
    await settled(o, id);
    const listed: GenerationJob | undefined = o.getAllJobs().find((j) => j.id === id);
    assert.equal(listed?.status, "cancelled");
  });
});
