# Anuj's Blog

A blog platform where the posts are written by a pipeline of cooperating AI agents. Agents gather current knowledge, pull recent AI news, draft a post, critique it, and revise it against that critique before anything is published. A human still approves the result.

## The agent pipeline

Coordinated by `server/ai-agents/orchestrator.ts`:

| Agent | Role |
| --- | --- |
| `latestKnowledgeAgent` | Gathers current context on the topic before drafting begins |
| `newsAgent` | Fetches recent AI news (configurable lookback window) and scores each article for relevance to the focus topic |
| `contentAgent` | Drafts the post — either from a chosen topic with an optional custom instruction, or in bulk from the filtered news articles |
| `reviewAgent` | Critiques the draft and produces a quality score |
| `enhanceAgent` | Revises the draft, working *only* from the review feedback rather than its own opinions |

Two entry points: generate a single post from a topic you supply, or run a job that sweeps recent news and produces several. Posts render Mermaid diagrams so that explanations can carry a picture.

## Stack

- **Frontend**: React 18 + TypeScript, Vite, Tailwind CSS, Radix UI
- **Backend**: Express 4, TypeScript, ES modules
- **Database**: Postgres via Drizzle ORM on Neon serverless — `users`, `posts`, `categories`, `tags`, `comments`
- **AI**: OpenAI (gpt-4o, gpt-4o-search-preview, gpt-5)
- **Auth**: Passport
- **Media**: Google Cloud Storage
- **Diagrams**: Mermaid

## Running it

```bash
npm install
npm run dev
```

Needs `DATABASE_URL` (Neon Postgres) and an OpenAI API key in the environment. Then:

```bash
npm run db:push   # apply the Drizzle schema
npm run build     # vite build + esbuild the server
npm start         # run the production build
npm run check     # typecheck
```

## API

Public reading:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/posts` | List posts |
| `GET` | `/api/posts/:slug` | Fetch one post |
| `POST` | `/api/posts/:id/like` | Like a post |
| `GET` | `/api/categories` | List categories |
| `POST` | `/api/comments/:id/like` | Like a comment |

Agent controls (admin):

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/ai/generate` | Run the pipeline over recent news |
| `POST` | `/api/ai/generate-custom` | Generate one post from a topic + custom instruction |
| `GET` | `/api/ai/jobs` | Inspect generation jobs |
| `GET` | `/api/ai/news` | Inspect fetched news articles |
| `GET` | `/api/ai/stats` | Generation statistics |

## Note

Generated posts are reviewed before publication rather than posted automatically. The review-then-enhance loop exists because a single generation pass reliably produced confident, shallow copy — the critique step is what makes the output worth reading.
