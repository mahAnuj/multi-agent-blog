// Display rules for AI generation jobs on the dashboard. Kept free of React so
// they can be tested on their own.

export type JobStatus =
  | "pending"
  | "fetching"
  | "analyzing"
  | "generating"
  | "reviewing"
  | "enhancing"
  | "completed"
  | "failed"
  | "cancelled";

/** Jobs in these states are over: no progress bar, no Cancel button. */
export const FINISHED_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled"];

export interface JobSummary {
  id: string;
  status: JobStatus;
  startedAt: string;
  config: { focusTopic?: string };
}

export function isRunning(job: Pick<JobSummary, "status">): boolean {
  return !FINISHED_STATUSES.includes(job.status);
}

/** What the dashboard calls the job: its topic, or the news sweep when it has none. */
export function jobName(job: Pick<JobSummary, "config">): string {
  return job.config.focusTopic?.trim() || "General AI News";
}

/**
 * "Kubernetes (started 10:42:07)". The start time tells two jobs with the same
 * name apart, e.g. two news sweeps without a focus topic.
 */
export function jobLabel(job: Pick<JobSummary, "config" | "startedAt">, locale?: string): string {
  const started = new Date(job.startedAt).toLocaleTimeString(locale);
  return `${jobName(job)} (started ${started})`;
}

export interface ToastContent {
  title: string;
  description: string;
  variant?: "destructive";
}

export type CancelResult =
  | { kind: "cancelled" }
  | { kind: "already_cancelled" }
  | { kind: "already_finished"; status: JobStatus }
  | { kind: "error"; message: string };

/**
 * Turns the DELETE /api/ai/jobs/:id outcome into what the user is told.
 * `error` is what apiRequest throws: "<status>: <body>".
 */
export function interpretCancelError(error: unknown): CancelResult {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^(\d{3}): ([\s\S]*)$/.exec(message);
  if (match && match[1] === "409") {
    try {
      const body = JSON.parse(match[2]) as { status?: JobStatus };
      if (body.status === "cancelled") return { kind: "already_cancelled" };
      if (body.status) return { kind: "already_finished", status: body.status };
    } catch {
      /* not JSON: fall through */
    }
  }
  if (match && match[1] === "404") return { kind: "error", message: "This job no longer exists." };
  return { kind: "error", message: message || "Failed to cancel job" };
}

export function cancelToast(job: Pick<JobSummary, "config" | "startedAt">, result: CancelResult, locale?: string): ToastContent {
  const label = jobLabel(job, locale);
  switch (result.kind) {
    case "cancelled":
      return { title: "Job cancelled", description: `${label} has been cancelled. Nothing more will be generated for it.` };
    case "already_cancelled":
      // A second click, or another tab got there first: the outcome is what the user wanted.
      return { title: "Job cancelled", description: `${label} was already cancelled.` };
    case "already_finished":
      return {
        title: "Too late to cancel",
        description: `${label} had already ${result.status === "completed" ? "completed" : result.status} before the cancel arrived.`,
      };
    case "error":
      return { title: "Cancel failed", description: `${label}: ${result.message}`, variant: "destructive" };
  }
}

/** Success rate over jobs that actually ran to an outcome; cancelled jobs are left out. */
export function successRate(stats: { completedJobs: number; failedJobs: number }): number {
  const decided = stats.completedJobs + stats.failedJobs;
  return decided > 0 ? Math.round((stats.completedJobs / decided) * 100) : 0;
}

export function statusBadgeClass(status: JobStatus): string {
  switch (status) {
    case "completed":
      return "bg-green-500";
    case "failed":
      return "bg-red-500";
    case "cancelled":
      return "bg-amber-500";
    case "pending":
      return "bg-gray-500";
    default:
      return "bg-blue-500";
  }
}
