import type { Express, RequestHandler } from "express";
import type { AIOrchestrator } from "./ai-agents/orchestrator.js";

/**
 * Job status, listing, cancellation and stats for the AI dashboard. Kept apart
 * from registerRoutes so it can be exercised with a test orchestrator.
 */
export function registerJobRoutes(app: Express, orchestrator: Pick<AIOrchestrator, "getJobStatus" | "getAllJobs" | "cancelJob" | "getStats">, guard: RequestHandler): void {
  // Get generation job status
  app.get("/api/ai/jobs/:jobId", guard, async (req, res) => {
    try {
      const { jobId } = req.params;
      const job = orchestrator.getJobStatus(jobId);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      
      res.json(job);
    } catch (error) {
      console.error("Error fetching job status:", error);
      res.status(500).json({ error: "Failed to fetch job status" });
    }
  });

  // Get all jobs (admin dashboard)
  app.get("/api/ai/jobs", guard, async (req, res) => {
    try {
      const jobs = orchestrator.getAllJobs();
      res.json(jobs);
    } catch (error) {
      console.error("Error fetching jobs:", error);
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  // Cancel a generation job
  app.delete("/api/ai/jobs/:jobId", guard, async (req, res) => {
    try {
      const { jobId } = req.params;
      const result = orchestrator.cancelJob(jobId);

      if (result.outcome === "not_found") {
        return res.status(404).json({ error: "Job not found" });
      }
      if (result.outcome === "already_finished") {
        // 409 with the job's real status, so a second click (or a second tab)
        // can tell "already cancelled" apart from "finished before the cancel".
        return res.status(409).json({
          error: `Job already ${result.job.status}`,
          status: result.job.status,
          job: result.job,
        });
      }

      res.json({ status: "cancelled", job: result.job });
    } catch (error) {
      console.error("Error cancelling job:", error);
      res.status(500).json({ error: "Failed to cancel job" });
    }
  });

  // Get AI generation statistics
  app.get("/api/ai/stats", guard, async (req, res) => {
    try {
      const stats = orchestrator.getStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching AI stats:", error);
      res.status(500).json({ error: "Failed to fetch statistics" });
    }
  });
}
