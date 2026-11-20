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
- **AI**: OpenAI — `gpt-4o` throughout, plus `gpt-4o-search-preview` for the web-search step
- **Auth**: Passport
- **Media**: Google Cloud Storage
- **Diagrams**: Mermaid

## Running it

```bash
npm install
cp .env.example .env   # then fill it in
npm run dev
```

`npm run dev` loads `.env` via dotenv. Required variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Neon serverless) |
| `OPENAI_API_KEY` | Required at startup — the agents construct their clients eagerly |
| `ADMIN_PASSWORD` | Gates every admin and agent route. **If unset, those routes refuse with 503 rather than falling open.** |

Other scripts:

```bash
npm run db:push   # apply the Drizzle schema
npm run build     # vite build + esbuild the server into dist/
npm run check     # typecheck
npm test          # cancellation tests (no database or OpenAI key needed)
```

```bash
npm run build && npm start   # production: bundled server on dist/index.js
```

## Admin access

The dashboard lives at `/ai-dashboard`, behind `/admin`.

Sign-in posts the password to `/api/admin/login`; the server compares it against
`ADMIN_PASSWORD` in constant time and returns a random 32-byte session token,
held in memory for 12 hours. The client sends it as `Authorization: Bearer <token>`
and the server rejects anything else. Tokens die on restart, and `/api/admin/logout`
revokes one immediately.

The admin password is never present in client code.

## Generation options

Both generation modes accept:

- **Model** — `gpt-4o`, `gpt-4o-mini`, `gpt-4.1` or `gpt-4.1-mini`, applied to drafting,
  review, enhancement and knowledge gathering for that run. The web-search step is
  pinned to a search-enabled model and is not selectable.
- **Target keywords** — comma-separated. The first is treated as primary and is steered
  into the title and opening paragraph; the rest inform headings and meta fields. The
  prompt explicitly instructs against keyword-stuffing.

## Cancelling a job

**Cancel** on the dashboard (or `DELETE /api/ai/jobs/:jobId`) stops a running job:

- The job is marked `cancelled` at once, a status of its own: it is not shown as
  failed and is left out of the success rate.
- Its in-flight OpenAI requests and image checks are aborted, and the pipeline starts
  no further step, drafts nothing more and saves no further post.
- A post whose save was already under way when the cancel arrived is kept and listed
  on the cancelled job.
- A job that already finished can't be cancelled: the API answers `409` with its real
  status, so a second click reports "already cancelled" rather than an error.
- An OpenAI request that is aborted mid-flight may still be billed for the tokens it
  had used.

## API

Public reading:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/posts` | List posts |
| `GET` | `/api/posts/:slug` | Fetch one post |
| `POST` | `/api/posts/:id/like` | Like a post |
| `GET` | `/api/categories` | List categories |
| `POST` | `/api/comments/:id/like` | Like a comment |

Admin — all require a valid bearer token:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/ai/generate` | Run the pipeline over recent news |
| `POST` | `/api/ai/generate-custom` | Generate one post from a topic, keywords and instructions |
| `GET` | `/api/ai/jobs` | Inspect generation jobs |
| `DELETE` | `/api/ai/jobs/:jobId` | Cancel a running job (`409` if it already finished) |
| `GET` | `/api/ai/news` | Inspect fetched news articles |
| `GET` | `/api/ai/stats` | Generation statistics |
| `GET` | `/api/posts/drafts` | List unpublished drafts |
| `POST` | `/api/posts` | Create a post |
| `PUT` | `/api/posts/:id` | Update a post |
| `DELETE` | `/api/posts/:id` | Delete a post |

## Note

Generated posts are reviewed before publication rather than posted automatically. The review-then-enhance loop exists because a single generation pass reliably produced confident, shallow copy — the critique step is what makes the output worth reading.
