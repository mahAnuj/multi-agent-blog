// What the dashboard shows and says about cancelled jobs.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isRunning,
  jobName,
  jobLabel,
  interpretCancelError,
  cancelToast,
  successRate,
  statusBadgeClass,
  type JobStatus,
} from "./job-status.js";

const job = (focusTopic: string | undefined, startedAt = "2026-11-20T10:42:07Z") => ({ config: { focusTopic }, startedAt });
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB");

describe("job status", () => {
  test("cancelled is finished: no progress bar, no Cancel button", () => {
    const finished: JobStatus[] = ["completed", "failed", "cancelled"];
    for (const status of finished) assert.equal(isRunning({ status }), false, status);
    for (const status of ["pending", "fetching", "analyzing", "generating", "reviewing", "enhancing"] as JobStatus[]) {
      assert.equal(isRunning({ status }), true, status);
    }
  });

  test("cancelled has its own badge colour, distinct from failed", () => {
    assert.notEqual(statusBadgeClass("cancelled"), statusBadgeClass("failed"));
    assert.notEqual(statusBadgeClass("cancelled"), statusBadgeClass("completed"));
  });

  test("success rate leaves cancelled jobs out", () => {
    // 3 completed, 1 failed, (2 cancelled not passed in): 75%, not 50%.
    assert.equal(successRate({ completedJobs: 3, failedJobs: 1 }), 75);
    assert.equal(successRate({ completedJobs: 0, failedJobs: 0 }), 0);
  });
});

describe("naming the job", () => {
  test("a job is named by its topic", () => {
    assert.equal(jobName(job("Rust")), "Rust");
  });

  test("a news job without a focus topic is named as the news sweep, not left blank", () => {
    assert.equal(jobName(job(undefined)), "General AI News");
    assert.equal(jobName(job("")), "General AI News");
    assert.equal(jobName(job("   ")), "General AI News");
  });

  test("the label adds the start time, so two unnamed news jobs can be told apart", () => {
    const a = jobLabel(job(undefined, "2026-11-20T10:42:07Z"), "en-GB");
    const b = jobLabel(job(undefined, "2026-11-20T10:44:31Z"), "en-GB");
    assert.notEqual(a, b);
    assert.equal(a, `General AI News (started ${time("2026-11-20T10:42:07Z")})`);
  });
});

describe("cancel outcomes", () => {
  const conflict = (status: string) => new Error(`409: ${JSON.stringify({ error: `Job already ${status}`, status })}`);

  test("a 409 for an already-cancelled job is the outcome the user wanted, not a failure", () => {
    const result = interpretCancelError(conflict("cancelled"));
    assert.deepEqual(result, { kind: "already_cancelled" });
    const toast = cancelToast(job("Rust"), result, "en-GB");
    assert.equal(toast.variant, undefined, "not shown as an error");
    assert.match(toast.description, /^Rust \(started .+\) was already cancelled\.$/);
  });

  test("a 409 for a job that finished first says it was too late", () => {
    const result = interpretCancelError(conflict("completed"));
    assert.deepEqual(result, { kind: "already_finished", status: "completed" });
    const toast = cancelToast(job("Rust"), result, "en-GB");
    assert.equal(toast.title, "Too late to cancel");
    assert.match(toast.description, /had already completed/);
  });

  test("a 404 or a server error is a real failure and names the job", () => {
    const missing = cancelToast(job("Rust"), interpretCancelError(new Error('404: {"error":"Job not found"}')), "en-GB");
    assert.equal(missing.variant, "destructive");
    assert.match(missing.description, /^Rust \(started .+\): This job no longer exists\.$/);

    const broken = cancelToast(job(undefined), interpretCancelError(new Error("500: boom")), "en-GB");
    assert.equal(broken.variant, "destructive");
    assert.match(broken.description, /^General AI News \(started .+\): 500: boom$/);
  });

  test("the success toast names the cancelled job, including news jobs without a topic", () => {
    const named = cancelToast(job("Rust"), { kind: "cancelled" }, "en-GB");
    assert.equal(named.title, "Job cancelled");
    assert.match(named.description, /^Rust \(started .+\) has been cancelled\./);
    const unnamed = cancelToast(job(undefined), { kind: "cancelled" }, "en-GB");
    assert.match(unnamed.description, /^General AI News \(started .+\) has been cancelled\./);
  });
});
