// The job API over real HTTP: a real orchestrator whose agents wait until
// they are aborted, so jobs stay running until the test cancels them.
import { describe, test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { AIOrchestrator } from "./ai-agents/orchestrator.js";
import { currentJobSignal } from "./ai-agents/jobContext.js";
import { registerJobRoutes } from "./jobRoutes.js";

/** Never answers; rejects when the job's signal aborts, like an SDK call. */
const waitForAbort = () =>
  new Promise<never>((_, reject) => {
    const signal = currentJobSignal();
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });

let finishImmediately = false;
let postsSaved = 0;
const agent = (value: unknown) => () => (finishImmediately ? Promise.resolve(value) : waitForAbort());
const doc = { title: "T", content: "x", summary: "s", tags: [], sources: [], codeSamples: [] };

const orchestrator = new AIOrchestrator(
  { fetchLatestNews: agent([]), analyzeRelevance: agent([]) } as any,
  { generateCustomBlogPost: agent(doc), generateMultipleBlogPosts: agent([]) } as any,
  { reviewContent: agent({ approved: true, qualityScore: 99, issues: [], suggestedFixes: [] }) } as any,
  { enhanceContent: agent({ enhancedContent: doc, improvementsMade: [] }) } as any,
  { gatherLatestKnowledge: agent({}) } as any,
  { createPost: async () => ({ id: `p${++postsSaved}` }), getTags: async () => [], createTag: async (t: object) => t } as any,
);

const adminOnly: RequestHandler = (req, res, next) =>
  req.headers.authorization === "Bearer admin" ? next() : res.status(401).json({ error: "Unauthorized" });

let server: Server;
let base = "";
const api = (method: string, path: string, auth = true) =>
  fetch(`${base}${path}`, { method, headers: auth ? { authorization: "Bearer admin" } : {} });

before(async () => {
  const app = express();
  app.use(express.json());
  registerJobRoutes(app, orchestrator, adminOnly);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  finishImmediately = false;
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

/** A pipeline that keeps running after the test expected it to stop is a failure, not a hang. */
const settled = (id: string, ms = 2000) =>
  Promise.race([
    orchestrator.whenSettled(id),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`job ${id} still running after ${ms} ms`)), ms).unref()),
  ]);

const startCustom = () => orchestrator.startCustomGeneration({ topic: "Rust", type: "custom" });

describe("DELETE /api/ai/jobs/:jobId", () => {
  test("still requires admin auth", async () => {
    const id = await startCustom();
    const res = await api("DELETE", `/api/ai/jobs/${id}`, false);
    assert.equal(res.status, 401);
    assert.notEqual(orchestrator.getJob(id)!.status, "cancelled");
    orchestrator.cancelJob(id);
    await settled(id);
  });

  test("an unknown job is 404", async () => {
    const res = await api("DELETE", "/api/ai/jobs/does-not-exist");
    assert.equal(res.status, 404);
  });

  test("cancels a running job, and GET by id and the job list both report 'cancelled'", async () => {
    const id = await startCustom();
    const res = await api("DELETE", `/api/ai/jobs/${id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "cancelled");
    assert.equal(body.job.status, "cancelled");

    await settled(id);
    const one = await (await api("GET", `/api/ai/jobs/${id}`)).json();
    assert.equal(one.status, "cancelled");
    assert.equal(one.error, undefined);
    const list = await (await api("GET", "/api/ai/jobs")).json();
    assert.equal(list.find((j: { id: string }) => j.id === id).status, "cancelled");
  });

  test("a second cancel is 409 and says the job is already cancelled", async () => {
    const id = await startCustom();
    assert.equal((await api("DELETE", `/api/ai/jobs/${id}`)).status, 200);
    const again = await api("DELETE", `/api/ai/jobs/${id}`);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).status, "cancelled");
    await settled(id);
  });

  test("two clicks at once: exactly one succeeds, the other is a 409 saying cancelled", async () => {
    const id = await startCustom();
    const [a, b] = await Promise.all([api("DELETE", `/api/ai/jobs/${id}`), api("DELETE", `/api/ai/jobs/${id}`)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const conflict = a.status === 409 ? a : b;
    assert.equal((await conflict.json()).status, "cancelled");
    await settled(id);
  });

  test("a job that already completed cannot be cancelled (409) and stays completed", async () => {
    finishImmediately = true;
    const id = await startCustom();
    await settled(id);
    assert.equal(orchestrator.getJob(id)!.status, "completed");
    const res = await api("DELETE", `/api/ai/jobs/${id}`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).status, "completed");
    assert.equal(orchestrator.getJob(id)!.status, "completed");
  });
});

describe("GET /api/ai/stats", () => {
  test("reports cancelled jobs separately from failed ones", async () => {
    const before = await (await api("GET", "/api/ai/stats")).json();
    const id = await startCustom();
    await api("DELETE", `/api/ai/jobs/${id}`);
    await settled(id);
    const stats = await (await api("GET", "/api/ai/stats")).json();
    assert.equal(stats.cancelledJobs, before.cancelledJobs + 1);
    assert.equal(stats.failedJobs, before.failedJobs);
  });
});
