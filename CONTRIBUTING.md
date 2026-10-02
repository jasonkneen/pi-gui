# Contributing to pi-gui

Thanks for your interest in improving pi-gui. This guide covers local setup, the
test lanes, and what "done" means for a change.

## Prerequisites

- Node 20+
- [pnpm](https://pnpm.io), managed through `corepack`; `pnpm-lock.yaml` is the
  authoritative lockfile

```bash
corepack enable
pnpm install
```

## Development loop

```bash
pnpm dev         # run the desktop app (electron-vite, hot reload)
pnpm typecheck   # type-check all workspaces
pnpm lint        # lint all workspaces
pnpm build       # build all workspaces
```

`pnpm dev` rebuilds the shared workspace packages up front and keeps them in watch
mode, so Node-side package changes are picked up without a manual rebuild.

## Testing

Desktop end-to-end tests run against a real Electron build using a Playwright +
Electron harness, split into lanes:

- `core` — the default lane, runs on `pnpm test`.
- `live` — exercises live agent runs; needs working `pi` provider auth locally.
- `native` — foreground/OS-integration behaviors (open folder, paste, attachments).

```bash
pnpm test                                        # each workspace's tests (desktop: core lane)
pnpm --filter @pi-gui/desktop run test:e2e:all   # core + live + native
```

macOS is the source of truth for desktop UI verification. Linux is supported for
packaging and manual validation. See [`apps/desktop/README.md`](./apps/desktop/README.md)
for the full lane list and platform-specific packaging notes.

## Expectations for a change

- **Verify on the real surface.** Desktop changes should be confirmed on the actual
  Electron app, not only via unit tests. Transcript/timeline behavior, session
  correctness, and Codex-style UX are treated as product features.
- **Keep the renderer/main/preload boundary tight.** Don't widen the renderer's Node
  access; route through the typed IPC surface.
- **Keep `pi-sdk-driver` thin.** Prefer adapting upstream `pi` behavior over forking
  or reimplementing it.
- **Make focused commits.** One logical change per commit so the diff is easy to
  review.

Repo-wide conventions live in [`AGENTS.md`](./AGENTS.md) (the root `CLAUDE.md` is a
symlink to it). Path-scoped guidance lives in nested `AGENTS.md` files.

## Pull requests

- Describe what changed and how you verified it.
- Make sure `pnpm typecheck`, `pnpm lint`, and the relevant test lane pass.
- Keep unrelated changes out of the PR.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
