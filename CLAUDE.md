# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

### Important: do not use `git add .` or `git commit .`

## Commands

```bash
# Services (required for dev/tests)
docker-compose -f docker-compose.dev.yaml up -d

npm run dev             # Start dev server
npm run typecheck       # TypeScript check — use this, NOT npx tsc or npm run build
npm run lint:fix        # ESLint auto-fix
npm run format          # Prettier format
npm run format:check    # Check formatting without writing

# Tests
npm run test                    # Run all tests once
npm run test -- <filename>      # Run a single test file
npm run test:watch              # Watch mode
npm run test:coverage           # With coverage

# Database
npm run migrate:dev             # Apply + generate in dev
npm run migrate:prod            # Deploy migrations in production
npx prisma generate             # Regenerate Prisma client only
npm run reset                   # Reset DB (dev only)

# Utilities
npm run seed:admin              # Seed first admin user
npm run cleanup:jobs            # Clean BullMQ jobs
npm run dev:clean               # Restart app container and clear Vite cache
```

## Architecture

### Tech Stack
- **Frontend**: React 19, React Router v7, TypeScript, Tailwind CSS, Radix UI
- **Backend**: React Router v7 loaders/actions + Express middleware
- **Database**: PostgreSQL 16 via Prisma (generated client at `app/generated/prisma/client/`)
- **Cache/Queue**: Redis 7 + BullMQ for async grading jobs
- **Storage**: MinIO (S3-compatible) for file uploads
- **AI**: Gemini (primary, supports 3-key rotation for 3× throughput) → OpenAI (fallback)
- **Real-time**: Socket.io with Redis adapter (`app/lib/websocket/`)
- **Logging**: pino via `app/utils/logger.ts`

### Request Flow

1. React Router v7 handles routing — **never use `@remix-run/*` imports**, always `react-router`
2. Routes defined in `app/routes.ts` using the `route()` / `prefix()` / `index()` API
3. Auth check via `app/middleware/auth.server.ts` → `requireAuth(request)` throws redirect on failure
4. Server data loaded in `loader` functions, mutations in `action` functions
5. API routes (prefix `/api/`) live in `app/api/` and `app/routes/api.*`

### Key Directories

| Path | Purpose |
|------|---------|
| `app/routes/` | UI routes (teacher/, student/, admin/, auth/) |
| `app/api/` | Pure API handlers (REST endpoints) |
| `app/services/*.server.ts` | Business logic — all DB/AI calls live here |
| `app/middleware/` | Auth and API key middleware |
| `app/lib/db.server.ts` | Singleton Prisma client (import as `@/lib/db.server`) |
| `app/lib/websocket/` | Socket.io client/server helpers |
| `app/types/` | Shared TypeScript interfaces (check here before creating new ones) |
| `app/schemas/` | Zod validation schemas |
| `app/stores/` | Zustand client-side stores |
| `app/workers/grading.server.ts` | BullMQ grading worker |
| `app/config/redis.ts` | Redis connection config |

### Roles & Data Model

Three roles: `TEACHER`, `STUDENT`, `ADMIN`. Users must explicitly select a role after first login (`hasSelectedRole` flag). Core hierarchy: `Course → Class → Assignment → Submission`. Grading flows through `GradingSession` with results stored per `Submission`.

### AI Grading Pipeline

`grading-engine.server.ts` picks the path by feature flags: `USE_AGENT_GRADING=true` → `agent-executor.server.ts` (ToolLoopAgent); else `USE_AI_SDK_GRADING=true` → `ai-grader-sdk.server.ts` (`gradeWithAI`); else legacy `AIGrader` in `ai-grader.server.ts`.

Provider order for the Agent and AI SDK paths comes from `GRADING_PROVIDER_ORDER` (default `vllm,gemini,openai`, see `getGradingProviderOrder()`):
1. vLLM (OpenAI-compatible endpoint, `vllm-provider.server.ts`; skipped when `VLLM_BASE_URL` / `VLLM_MODEL_NAME` unset or health check fails)
2. Gemini (`RotatingGeminiService` / KeyHealthTracker when 3 keys configured, single key otherwise)
3. OpenAI (AI SDK path only; the Agent path needs tool calling and does not fall back to OpenAI)

`GEMINI_API_KEY` must not be an empty string (use a placeholder if unused); see `future-list.md` F002.

Heavy grading jobs are enqueued to BullMQ via `bullmq-grading.server.ts` and processed by the worker initialized in `startup.server.ts` at server boot.

### File Naming Conventions

- Server-only code: `.server.ts` suffix (prevents client bundle inclusion)
- Path alias `@/` maps to `app/` root
- Routes: React Router v7 file conventions under `app/routes/`
- Components: PascalCase in `app/components/`
- Utilities: camelCase in `app/utils/`

### Service Layer Rules

Services in `app/services/*.server.ts`:
- Return fallback values on error — do **not** throw to routes
- Use `db` from `@/lib/db.server` for all DB operations
- Use transactions for multi-step operations
- Log with `logger` from `@/utils/logger`

### State Management

- **Zustand** (`app/stores/`) for client-side global state
- **TanStack Query** for server state / data fetching
- **React Context** for theme and i18n
- **URL search params** for shareable state (filters, sort, pagination)

### Testing

Tests run against the development database — Docker must be running. All tests execute sequentially (`fileParallelism: false`, `singleThread: true`) to prevent DB conflicts. Each test must clean up via `cleanupTestData()`.

```
test/
├── integration/   # Full workflow + UI tests
├── unit/          # Isolated functions
├── contract/      # API contract validation
├── load/          # Performance tests
├── fixtures/      # Shared test data
├── factories/     # Test data builders
└── mocks/         # Mock services + MSW handlers
```

Set `USE_REAL_APIS=true` in env to skip MSW mocks and hit real AI APIs in tests.

## Critical Rules

- **Never use `any`** — create a typed interface; check `app/types/` for existing ones first
- **Never use `require()`** — ES modules only, use `import`
- Use `npm run typecheck` — not `npx tsc` and not `npm run build` for type checking
- Validate all API inputs with Zod schemas from `app/schemas/`
- `console.log` is forbidden in production code — use `logger` from `@/utils/logger`
