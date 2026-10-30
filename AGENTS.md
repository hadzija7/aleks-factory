<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project: Aleks Factory

Kanban board (Next.js 16, App Router, Tailwind 4) that hands tasks to a Mozaik agent (`@mozaik-ai/core`).

- Dev: `pnpm dev` · Verify: `pnpm lint && pnpm typecheck && pnpm build` · Test: `pnpm test` (vitest; sandbox tests need Docker + the sandbox image)
- Tasks persist in `data/tasks.json` (gitignored) via `src/lib/task-store.ts`.
- Moving a task to `in_progress` (PATCH `/api/tasks/[id]`) calls `executeTask` in `src/lib/agent.ts`: the "Kanban Board" human sends a `task.assigned` event, the "Task Executor" agent reacts with `runLoop`, and the board marks the task `done`/`failed` on `model.answer`.
- Env: `OPENAI_API_KEY` (or the provider key for `MOZAIK_MODEL`), see `.env.example`.
- Mozaik is pinned to stable 4.1.0 (event-driven runtime: `defineRuntime`, `createAgent`, `createHuman`, `runLoop`). `runLoop` emits no error event, so a custom `InferenceRunner` in `agent.ts` turns inference errors into failures.
- Agent tools live in `src/lib/coding-tools.ts` (`createCodingTools(root)` returns Mozaik `FunctionTool`s: `list_files`, `read_file`, `edit_file`, `write_file`, `run_command`). Every path is confined to `AGENT_WORKSPACE` (default `data/workspace`). Tools throw on errors, and Mozaik's `DefaultFunctionCallRunner` sends the error back to the model as text.
- `run_command` runs in `src/lib/docker-sandbox.ts`: one container `agent-<taskId>` per task session (`--network none`, only the project root mounted at `/work`, 1 CPU / 1 GB / 256 pids, 60s timeout). It is removed when the task finishes, on process exit, and stale `agent-*` containers are removed on startup. Image: `AGENT_SANDBOX_IMAGE` (default `node:22-bookworm`).
