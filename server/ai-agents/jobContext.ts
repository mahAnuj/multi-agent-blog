// Ties the agents' outgoing requests to the generation job that made them,
// so cancelling a job aborts its in-flight OpenAI calls and image checks.
//
// The orchestrator runs each job's pipeline inside runInJob(). Anything that
// pipeline awaits (agent methods, their helpers) can read the job's signal
// through AsyncLocalStorage without it being passed through every call, and
// concurrent jobs never see each other's signal.
import { AsyncLocalStorage } from "node:async_hooks";
import { APIUserAbortError } from "openai";

interface JobScope {
  jobId: string;
  signal: AbortSignal;
}

const scope = new AsyncLocalStorage<JobScope>();

/** Thrown at a stage boundary once the job has been cancelled. */
export class JobCancelledError extends Error {
  constructor(jobId?: string) {
    super(jobId ? `Job ${jobId} was cancelled` : "Job was cancelled");
    this.name = "JobCancelledError";
  }
}

export function runInJob<T>(jobId: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return scope.run({ jobId, signal }, fn);
}

/** The current job's signal, or undefined outside a job (e.g. the news preview route). */
export function currentJobSignal(): AbortSignal | undefined {
  return scope.getStore()?.signal;
}

/** Second argument for openai.chat.completions.create(): the SDK aborts the request and does not retry. */
export function requestOptions(): { signal?: AbortSignal } {
  const signal = currentJobSignal();
  return signal ? { signal } : {};
}

/** True for any error that means "the job was cancelled", whichever layer raised it. */
export function isCancellation(error: unknown): boolean {
  if (error instanceof JobCancelledError || error instanceof APIUserAbortError) return true;
  if ((error as { name?: string } | null)?.name === "AbortError") return true; // fetch and timers
  // Inside a cancelled job, whatever a step threw is a consequence of the cancel.
  return currentJobSignal()?.aborted === true;
}

/**
 * Agents catch errors to fall back to defaults. A cancellation must not be
 * turned into a fallback result, so their catch blocks call this first.
 */
export function rethrowIfCancelled(error: unknown): void {
  if (isCancellation(error)) throw error;
}

export function throwIfJobCancelled(): void {
  const store = scope.getStore();
  if (store?.signal.aborted) throw new JobCancelledError(store.jobId);
}

/** setTimeout that ends early, with a JobCancelledError, when the job is cancelled. */
export function pause(ms: number): Promise<void> {
  const store = scope.getStore();
  if (!store) return new Promise((resolve) => setTimeout(resolve, ms));
  if (store.signal.aborted) return Promise.reject(new JobCancelledError(store.jobId));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobCancelledError(store.jobId));
    };
    const timer = setTimeout(() => {
      store.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    store.signal.addEventListener("abort", onAbort, { once: true });
  });
}
