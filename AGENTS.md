# AGENTS.md

Rules for anyone (human or agent) changing this repo. Product docs: [README.md](README.md), design: [docs/SPEC.md](docs/SPEC.md).

## Project in one paragraph

Chromium MV3 extension (TypeScript, esbuild) for reviewing videos and web pages with timestamped notes, a drawing overlay and screenshots, plus a local Node companion that serves the notes over MCP (stdio and HTTP). Everything stays local.

## Layout

- `src/shared/` data model (zod schema), IndexedDB, export/import, time helpers
- `src/adapters/` site adapters (generic, HTML5 video, YouTube, Remotion Studio). Remotion relies on undocumented Studio internals: keep that code isolated in `remotion.ts` and `bridge-main.ts`
- `src/overlay/`, `src/content/`, `src/background/`, `src/sidepanel/`, `src/options/` extension parts
- `src/companion/` Node companion: file store, HTTP API, MCP server
- `tests/unit/` Vitest, `tests/e2e/` Playwright (real Chromium with the unpacked extension), `tests/demo/` demo recording

## Before every commit or PR

```bash
npm run typecheck
npm test            # builds, then unit tests
npm run test:e2e    # builds, then Playwright e2e
```

CI runs the same on every push. Do not skip a failing test; fix it or say why it is wrong.

## Fixing bugs

1. Write a regression test first, and confirm it **fails** on the base branch.
2. Fix the cause, not the symptom.
3. Update `README.md` / `docs/SPEC.md` if documented behavior changed.

## UI changes and UI fixes: show them

Any change a user can see (side panel, overlay, toolbar, options page, messages) needs **visual proof in the PR**. Tests passing is not enough.

- **Bug fix:** a before video (bug visible, on the base branch) and an after video (same scenario, fixed).
- **New or changed UI:** an after video, plus stills of the key states.
- Same scenario and same data in both recordings, so the difference is the change.
- Caption each recording (`BEFORE (main)` / `AFTER (fix)`) and keep each under about 20 seconds.

How to record (Playwright is already set up for it):

1. Write a temporary paced spec using the fixtures in `tests/e2e/fixtures.ts`. They record every page when `PW_VIDEO_DIR` is set. Do not commit this spec.
2. Run it twice: once with the base branch's version of the changed files built (`git show main:<file> > <file>`, `npm run build`), once with the fix built. Restore the files afterwards.
3. Stitch the page window and the panel window side by side with ffmpeg (see `scripts/record-demo.mjs`), add the caption, export H.264 `.mp4`, and extract one still per recording.
4. Look at the stills before publishing. Confirm they show what the PR claims.

Where to put the media:

- Push the files to the orphan branch `pr-media` under `<pr-branch-name>/`. Never commit videos to `main` or to the PR branch.
- In the PR description: `<video src=".../raw/pr-media/<pr-branch-name>/before.mp4" controls>` plus the PNG stills as images and direct links to the mp4 files. Stills are the fallback if inline video does not play.

## Commits and PRs

- Conventional Commits (`fix(sidepanel): ...`, `feat: ...`, `ci: ...`).
- No `Co-Authored-By` or "generated with" trailers, and no AI tool names, in commit messages or PR descriptions.
- Say in the PR what was **not** verified.
- Branch from `main`, open a PR, do not push directly to `main` once the project has other contributors.

## Privacy and security

- No secrets in the repo. The manifest `key` is a public key that only pins the extension ID.
- The companion listens on loopback only. Do not widen the Host/Origin checks in `src/companion/http.ts` without a test and a note in `docs/SPEC.md`.
- Keep the extension local-first: no network calls except to the user's own companion on `127.0.0.1`.
