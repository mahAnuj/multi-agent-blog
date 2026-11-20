import { randomUUID } from 'crypto';
import type { NewsAgent, NewsArticle } from './newsAgent.js';
import type { ContentAgent, GeneratedContent } from './contentAgent.js';
import type { ReviewAgent, ReviewResult } from './reviewAgent.js';
import type { EnhanceAgent, EnhancementResult } from './enhanceAgent.js';
import { LatestKnowledgeAgent } from './latestKnowledgeAgent.js';
import type { IStorage } from '../storage.js';
import { resolveModel, DEFAULT_MODEL, type ChatModel } from "./models.js";
import { runInJob, throwIfJobCancelled, isCancellation, JobCancelledError } from "./jobContext.js";

export interface GenerationConfig {
  hoursBack: number;
  minRelevanceScore: number;
  maxArticles: number;
  focusTopic?: string;
  keywords?: string | null;
  model?: ChatModel;
}

export interface CustomGenerationConfig {
  topic: string;
  userPrompt?: string | null;
  keywords?: string | null;
  model?: ChatModel;
  type: 'custom';
}

export type JobStatus = 'pending' | 'fetching' | 'analyzing' | 'generating' | 'reviewing' | 'enhancing' | 'completed' | 'failed' | 'cancelled';

/** A job in one of these states never changes again. */
export const FINISHED_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

export type CancelOutcome =
  | { outcome: 'cancelled'; job: GenerationJob }
  | { outcome: 'not_found' }
  | { outcome: 'already_finished'; job: GenerationJob };

export interface GenerationJob {
  id: string;
  status: JobStatus;
  progress: number;
  startedAt: string;
  completedAt?: string;
  /** When the cancel was accepted. The pipeline may take a moment longer to unwind. */
  cancelledAt?: string;
  error?: string;
  config: GenerationConfig;
  results?: {
    articlesFound: number;
    articlesAnalyzed: number;
    blogPostGenerated: boolean;
    postId?: string;
    postIds?: string[];
    reviewResults?: Array<{postId: string; approved: boolean; qualityScore: number}>;
  };
}

export interface AIStats {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  cancelledJobs: number;
  averageArticlesPerJob: number;
  averageGenerationTime: number;
}

class AIOrchestrator {
  private jobs: Map<string, GenerationJob> = new Map();
  /** One per running job; aborting it cancels that job's in-flight requests. */
  private controllers: Map<string, AbortController> = new Map();
  /** Resolves when a job's pipeline has fully stopped, whatever its outcome. */
  private pipelines: Map<string, Promise<void>> = new Map();
  private newsAgent: NewsAgent;
  private contentAgent: ContentAgent;
  private reviewAgent: ReviewAgent;
  private enhanceAgent: EnhanceAgent;
  private knowledgeAgent: LatestKnowledgeAgent;
  private storage: IStorage;

  constructor(newsAgent: NewsAgent, contentAgent: ContentAgent, reviewAgent: ReviewAgent, enhanceAgent: EnhanceAgent, knowledgeAgent: LatestKnowledgeAgent, storage: IStorage) {
    this.newsAgent = newsAgent;
    this.contentAgent = contentAgent;
    this.reviewAgent = reviewAgent;
    this.enhanceAgent = enhanceAgent;
    this.knowledgeAgent = knowledgeAgent;
    this.storage = storage;
  }

  async startGeneration(config: GenerationConfig): Promise<string> {
    const jobId = randomUUID();
    
    const job: GenerationJob = {
      id: jobId,
      status: 'pending',
      progress: 0,
      startedAt: new Date().toISOString(),
      config
    };

    this.jobs.set(jobId, job);
    
    // Start the generation process asynchronously
    this.run(jobId, () => this.processGeneration(jobId));

    return jobId;
  }

  async startCustomGeneration(config: CustomGenerationConfig): Promise<string> {
    const jobId = randomUUID();
    
    const job: GenerationJob = {
      id: jobId,
      status: 'pending',
      progress: 0,
      startedAt: new Date().toISOString(),
      config: {
        hoursBack: 0, // Not used for custom generation
        minRelevanceScore: 0, // Not used for custom generation
        maxArticles: 1, // Generate one post
        focusTopic: config.topic,
        keywords: config.keywords ?? null,
        model: config.model
      }
    };

    this.jobs.set(jobId, job);
    
    // Start the custom generation process asynchronously
    this.run(jobId, () => this.processCustomGeneration(jobId, config.topic, config.userPrompt, config.keywords, config.model));

    return jobId;
  }

  /**
   * Runs a job's pipeline with its own abort signal. Every agent request made
   * while it runs is tied to that signal (see jobContext.ts).
   */
  private run(jobId: string, pipeline: () => Promise<void>): void {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    const done = runInJob(jobId, controller.signal, pipeline)
      .catch((error) => this.finishWithError(jobId, error))
      .finally(() => this.controllers.delete(jobId));
    this.pipelines.set(jobId, done);
  }

  /**
   * Resolves once the job's pipeline has stopped. A cancelled job reports
   * 'cancelled' immediately; this is when its last in-flight step has unwound.
   */
  whenSettled(jobId: string): Promise<void> {
    return this.pipelines.get(jobId) ?? Promise.resolve();
  }

  /**
   * Stage boundary: stop here if the job was cancelled. Pipelines call this
   * before starting each step and before saving anything.
   */
  private checkpoint(jobId: string): void {
    throwIfJobCancelled();
    if (this.jobs.get(jobId)?.status === 'cancelled') throw new JobCancelledError(jobId);
  }

  /** The pipeline threw. A cancelled job stays cancelled; anything else is a real failure. */
  private finishWithError(jobId: string, error: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'cancelled' || isCancellation(error)) {
      console.log(`Generation job ${jobId} stopped after cancellation`);
      return;
    }
    if (FINISHED_STATUSES.includes(job.status)) return;
    console.error(`Generation job ${jobId} failed:`, error);
    this.updateJob(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      progress: 0,
      completedAt: new Date().toISOString()
    });
  }

  /** Point every LLM-backed agent at the model chosen for this run. */
  private applyModel(model?: ChatModel): void {
    const resolved = resolveModel(model);
    this.contentAgent.model = resolved;
    this.reviewAgent.model = resolved;
    this.enhanceAgent.model = resolved;
    this.knowledgeAgent.model = resolved;
    console.log(`\u{1F9E0} Using model: ${resolved}`);
  }

  private async processCustomGeneration(jobId: string, topic: string, userPrompt?: string | null, keywords?: string | null, model?: ChatModel): Promise<void> {
    console.log(`🔍 Starting custom generation job ${jobId} for topic: ${topic}`);

    this.applyModel(model);

    // Step 1: Gather latest knowledge using LatestKnowledgeAgent
    this.checkpoint(jobId);
    this.updateJob(jobId, { status: 'fetching', progress: 15 });
    console.log(`🧠 Gathering latest knowledge for: ${topic}`);
    const knowledgeContext = await this.knowledgeAgent.gatherLatestKnowledge(topic);

    // Step 2: Generate blog post with current knowledge context
    this.checkpoint(jobId);
    this.updateJob(jobId, { status: 'generating', progress: 40 });
    const generatedContent = await this.contentAgent.generateCustomBlogPost(topic, userPrompt || undefined, knowledgeContext, keywords || undefined);

    if (generatedContent.codeSamples && generatedContent.codeSamples.length > 0) {
      // Code samples are already embedded in the content by the LLM
      console.log(`Generated ${generatedContent.codeSamples.length} code samples for the article`);
    }

    // Step 3: Review content with AI review agent
    this.checkpoint(jobId);
    this.updateJob(jobId, { status: 'reviewing', progress: 60 });
    const reviewResult = await this.reviewAgent.reviewContent(generatedContent, topic, userPrompt || undefined);

    // Step 4: Enhance content if review found issues
    let finalContent = generatedContent;
    if (!reviewResult.approved || reviewResult.qualityScore < 85) {
      this.checkpoint(jobId);
      this.updateJob(jobId, { status: 'enhancing', progress: 80 });
      const enhancement = await this.enhanceAgent.enhanceContent(generatedContent, reviewResult);
      finalContent = enhancement.enhancedContent;
      console.log(`Content enhanced. Improvements: ${enhancement.improvementsMade.join(', ')}`);
    }

    // Step 5: Save the blog post
    this.checkpoint(jobId);
    const postId = await this.saveBlogPost(finalContent, reviewResult);

    // Step 6: Complete (or, if the cancel landed while saving, report the post on the cancelled job)
    this.finish(jobId, {
      articlesFound: 0, // No articles for custom generation
      articlesAnalyzed: 0,
      blogPostGenerated: true,
      postId: postId
    });
  }

  private async processGeneration(jobId: string): Promise<void> {
    console.log(`Starting generation job ${jobId}`);

    // Step 1: Gather latest knowledge using LatestKnowledgeAgent
    this.checkpoint(jobId);
    this.updateJob(jobId, { status: 'fetching', progress: 5 });
    const job = this.getJob(jobId)!;
    this.applyModel(job.config.model);
    let knowledgeContext;

    if (job.config.focusTopic) {
      console.log(`🧠 Gathering latest knowledge for focus topic: ${job.config.focusTopic}`);
      knowledgeContext = await this.knowledgeAgent.gatherLatestKnowledge(job.config.focusTopic);
    }

    // Step 2: Fetch news
    this.checkpoint(jobId);
    this.updateJob(jobId, { status: 'fetching', progress: 15 });
    const articles = await this.newsAgent.fetchLatestNews(job.config.hoursBack);

    // Step 3: Analyze relevance
    this.checkpoint(jobId);
    this.updateJob(jobId, { status: 'analyzing', progress: 35 });
    const relevantArticles = await this.newsAgent.analyzeRelevance(articles, job.config.focusTopic);

    // Filter by relevance score and limit count
    const filteredArticles = relevantArticles
      .filter(article => article.relevanceScore >= job.config.minRelevanceScore)
      .slice(0, job.config.maxArticles);

    if (filteredArticles.length === 0) {
      throw new Error('No articles met the relevance criteria');
    }

    // Step 4: Generate multiple blog posts (one per article) with knowledge context
    this.checkpoint(jobId);
    this.updateJob(jobId, { status: 'generating', progress: 65 });
    const generatedPosts = await this.contentAgent.generateMultipleBlogPosts(filteredArticles, job.config.focusTopic, knowledgeContext, job.config.keywords || undefined);

    // Step 5: Process each post with review agent
    this.checkpoint(jobId);
    this.updateJob(jobId, { status: 'reviewing', progress: 80 });
    const savedPostIds: string[] = [];
    const results = () => ({
      articlesFound: articles.length,
      articlesAnalyzed: filteredArticles.length,
      blogPostGenerated: savedPostIds.length > 0,
      postId: savedPostIds[0], // First post ID for backward compatibility
      postIds: [...savedPostIds] // All post IDs
    });

    for (const generatedContent of generatedPosts) {
      try {
        this.checkpoint(jobId);

        // Code samples are already embedded in the content by the LLM
        if (generatedContent.codeSamples && generatedContent.codeSamples.length > 0) {
          console.log(`Content includes ${generatedContent.codeSamples.length} code samples`);
        }

        // Review content with AI review agent
        const reviewResult = await this.reviewAgent.reviewContent(generatedContent, job.config.focusTopic);

        // Enhance content if review found issues
        let finalContent = generatedContent;
        if (!reviewResult.approved || reviewResult.qualityScore < 85) {
          this.checkpoint(jobId);
          const enhancement = await this.enhanceAgent.enhanceContent(generatedContent, reviewResult);
          finalContent = enhancement.enhancedContent;
          console.log(`Content enhanced for article. Improvements: ${enhancement.improvementsMade.join(', ')}`);
        }

        // Save as draft (for manual review) or publish if approved
        this.checkpoint(jobId);
        const postId = await this.saveBlogPost(finalContent, reviewResult);
        if (postId) {
          savedPostIds.push(postId);
        }
      } catch (error) {
        if (isCancellation(error) || this.getJob(jobId)?.status === 'cancelled') {
          // Keep the posts already saved on the cancelled job, then stop.
          this.recordResults(jobId, results());
          throw error;
        }
        console.error('Error processing post:', error);
        // Continue with other posts
      }
    }

    // Step 6: Complete (or, if the cancel landed during the last save, report the posts on the cancelled job)
    this.finish(jobId, results());
  }

  /** Completes the job, unless it was cancelled meanwhile: then it only records what was saved. */
  private finish(jobId: string, results: NonNullable<GenerationJob['results']>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'cancelled') {
      this.recordResults(jobId, results);
      console.log(`Generation job ${jobId} stopped after cancellation`);
      return;
    }
    this.updateJob(jobId, {
      status: 'completed',
      progress: 100,
      completedAt: new Date().toISOString(),
      results
    });
    console.log(`Generation job ${jobId} completed successfully`);
  }

  /** Results are the one thing still written to a cancelled job, so posts it saved aren't lost. */
  private recordResults(jobId: string, results: NonNullable<GenerationJob['results']>): void {
    const job = this.jobs.get(jobId);
    if (job && (results.postIds?.length || results.postId)) job.results = results;
  }

  // Removed insertDiagrams method - using code samples instead of mermaid diagrams

  private async saveBlogPost(content: GeneratedContent, reviewResult?: ReviewResult): Promise<string> {
    try {
      // Create a unique slug
      const slug = content.title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim() + `-${Date.now()}`;

      // Calculate read time (approximate words per minute = 200)
      const wordCount = content.content.split(/\s+/).length;
      const readTime = Math.max(1, Math.ceil(wordCount / 200));

      // Determine status based on review results
      const status = reviewResult?.approved ? 'published' : 'draft';
      
      // Create post data
      const postData = {
        title: content.title,
        slug,
        content: content.content,
        excerpt: content.summary,
        status,
        featuredImageUrl: null,
        authorId: 'ai-system',
        categoryId: 'cat-1', // Use existing AI/LLM category
        readTime,
        tags: content.tags,
        metadata: {
          sources: content.sources,
          generatedAt: new Date().toISOString(),
          aiGenerated: true,
          reviewResult: reviewResult ? {
            approved: reviewResult.approved,
            qualityScore: reviewResult.qualityScore,
            issues: reviewResult.issues.length,
            criticalIssues: reviewResult.issues.filter(i => i.severity === 'critical').length
          } : undefined
        }
      };

      // Save the post
      const post = await this.storage.createPost(postData);

      // Add tags
      if (content.tags && content.tags.length > 0) {
        for (const tagName of content.tags) {
          try {
            // Create or get existing tag
            const existingTags = await this.storage.getTags();
            let tag = existingTags.find(t => t.name.toLowerCase() === tagName.toLowerCase());
            
            if (!tag) {
              const tagSlug = tagName.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
              tag = await this.storage.createTag({
                name: tagName,
                slug: tagSlug
              });
            }

            // Note: Tag association would be handled by storage layer if supported
          } catch (tagError) {
            console.error(`Error adding tag ${tagName}:`, tagError);
          }
        }
      }

      console.log(`Blog post saved with ID: ${post.id}`);
      return post.id;

    } catch (error) {
      console.error('Error saving blog post:', error);
      throw new Error(`Failed to save blog post: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Finished jobs are frozen, so a late step can never overwrite cancelled (or completed). */
  private updateJob(jobId: string, updates: Partial<GenerationJob>): void {
    const job = this.jobs.get(jobId);
    if (job && !FINISHED_STATUSES.includes(job.status)) {
      Object.assign(job, updates);
    }
  }

  getJob(jobId: string): GenerationJob | null {
    return this.jobs.get(jobId) || null;
  }

  getJobStatus(jobId: string): GenerationJob | null {
    return this.getJob(jobId);
  }

  getAllJobs(): GenerationJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => 
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  /**
   * Marks the job cancelled straight away and aborts its in-flight requests.
   * The pipeline stops at its next stage boundary and saves nothing more.
   */
  cancelJob(jobId: string): CancelOutcome {
    const job = this.jobs.get(jobId);
    if (!job) return { outcome: 'not_found' };
    if (FINISHED_STATUSES.includes(job.status)) return { outcome: 'already_finished', job };

    const now = new Date().toISOString();
    this.updateJob(jobId, { status: 'cancelled', cancelledAt: now, completedAt: now });
    this.controllers.get(jobId)?.abort(new JobCancelledError(jobId));
    console.log(`Generation job ${jobId} cancelled`);
    return { outcome: 'cancelled', job };
  }

  getStats(): AIStats {
    const jobs = Array.from(this.jobs.values());
    const completedJobs = jobs.filter(job => job.status === 'completed');
    const failedJobs = jobs.filter(job => job.status === 'failed');
    const cancelledJobs = jobs.filter(job => job.status === 'cancelled');
    
    const totalArticles = completedJobs.reduce((sum, job) => 
      sum + (job.results?.articlesAnalyzed || 0), 0
    );
    
    const totalGenerationTime = completedJobs.reduce((sum, job) => {
      if (job.startedAt && job.completedAt) {
        const startTime = new Date(job.startedAt).getTime();
        const endTime = new Date(job.completedAt).getTime();
        return sum + (endTime - startTime) / 1000; // in seconds
      }
      return sum;
    }, 0);

    return {
      totalJobs: jobs.length,
      completedJobs: completedJobs.length,
      failedJobs: failedJobs.length,
      cancelledJobs: cancelledJobs.length,
      averageArticlesPerJob: completedJobs.length > 0 ? totalArticles / completedJobs.length : 0,
      averageGenerationTime: completedJobs.length > 0 ? totalGenerationTime / completedJobs.length : 0
    };
  }
}

// Export the class for instantiation in routes
export default AIOrchestrator;
export { AIOrchestrator };