<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project: Aleks Factory

Kanban board (Next.js 16, App Router, Tailwind 4) that hands tasks to a Mozaik agent (`@mozaik-ai/core`).

- Dev: `pnpm dev` · Verify: `pnpm lint && pnpm typecheck && pnpm build` · Test: `pnpm test` (vitest; sandbox tests need Docker + the sandbox image)
- Projects and tasks persist in `data/projects.json` / `data/tasks.json` (gitignored) via `src/lib/project-store.ts` / `src/lib/task-store.ts` (shared `json-store.ts`).
- Each project is a local git repo at `data/projects/<id>/repo`, bootstrapped with create-next-app in Docker (`src/lib/workspace.ts`). Each task gets branch `task/<id8>` + worktree `data/projects/<id>/worktrees/<taskId>`; host git always passes `--git-dir`/`--work-tree` explicitly and disables hooks/fsmonitor because agents control worktree contents. Done tasks are reviewed in the diff viewer and committed + merged into main from the UI (`/api/tasks/[id]/diff`, `/commit`).
- Previews (`src/lib/preview.ts`) run `npm run dev` for a task worktree or main in a Docker container on a random localhost port. `node_modules` (per checkout) and the npm cache live in Docker volumes (`aleks-factory-nm-*`, `aleks-factory-npm-cache`) because bind-mounted installs on macOS take minutes. Containers carry an owner-pid label; startup only removes containers whose owner process is dead.
- `data/` is excluded from tsconfig, eslint and vitest (`pnpm test` runs `vitest run src`).
- Moving a task to `in_progress` (PATCH `/api/tasks/[id]`) calls `executeTask` in `src/lib/agent.ts`: the "Kanban Board" human sends a `task.assigned` event, the "Task Executor" agent reacts with `runLoop`, and the board marks the task `done`/`failed` on `model.answer`.
- Env: `OPENAI_API_KEY` (or the provider key for `MOZAIK_MODEL`), see `.env.example`.
- Mozaik is pinned to stable 4.1.0 (event-driven runtime: `defineRuntime`, `createAgent`, `createHuman`, `runLoop`). `runLoop` emits no error event, so a custom `InferenceRunner` in `agent.ts` turns inference errors into failures.
- Agent tools live in `src/lib/coding-tools.ts` (`createCodingTools(root)` returns Mozaik `FunctionTool`s: `list_files`, `read_file`, `edit_file`, `write_file`, `run_command`). Every path is confined to the task's worktree, and `.git` is off-limits. Tools throw on errors, and Mozaik's `DefaultFunctionCallRunner` sends the error back to the model as text.
- `run_command` runs in `src/lib/docker-sandbox.ts`: one container `agent-<taskId>` per task session (`--network none`, only the project root mounted at `/work`, 1 CPU / 1 GB / 256 pids, 60s timeout). It is removed when the task finishes, on process exit, and stale `agent-*` containers are removed on startup. Image: `AGENT_SANDBOX_IMAGE` (default `node:22-bookworm`).
- Review loop: when the executor answers, the board moves the task to `in_review` and emits `task.review_requested`; the "Code Reviewer" agent (read-only tools + `run_command`, structured output `{verdict, summary, findings}`) answers, then the board moves the task to `done` or back to `in_progress` (re-emitting `task.assigned` with `task.review`). After `MAX_REVIEW_ROUNDS` (default 3) fix rounds it fails. One sandbox per task, shared by both agents.
- Observability: when `MOZAIK_API_KEY` is set, `ensureRuntime` joins a `@mozaik-ai/cloud-sdk/exporter` participant that streams every runtime event to app.jigjoy.ai (one cloud session per server process; the live link is logged on first task). `MOZAIK_REDACTION` controls how much content is sent.
- Secrets: agents write them to `.env.local` in the checkout (instructions in `agent.ts`). Gitignored root `.env*` files are synced by `workspace.ts` (main -> new worktree, worktree -> main on merge, key-level merge, symlinks skipped) and only their key names are shown in the diff viewer.
