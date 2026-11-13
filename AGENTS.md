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
3. Stitch the page window and the panel window side by side with ffmpeg (see `scripts/record-demo.mjs`), add the caption, and export an H.264 `.mp4`, a looping `.gif` (about 10 fps, 900 px wide, palettegen), and one `.png` still per recording.
4. Look at the stills before publishing. Confirm they show what the PR claims.

Where to put the media:

- Create one **prerelease** named `pr-evidence-<PR number>-<yyyymmdd>` and attach the mp4, gif and png files to it (`gh release create <tag> --prerelease --title "PR #<n> evidence" --notes "..." files...`). Never commit videos to the repo.
- Create it in the repo your PR branch lives in: **your fork** if you are a contributor without write access, this repo if you are a maintainer. Release assets from a fork render fine in a PR on the upstream repo.
- In the PR description, put each video **alone on its own line** as a markdown link to the `.mp4`: `[Video: before (main) - what it shows](https://github.com/<owner>/<repo>/releases/download/<tag>/before.mp4)`. T3 Code's PR viewer turns a line that is only a link (or bare URL) ending in `.mp4`/`.webm`/`.mov`/`.m4v`/`.ogv`, or a standalone `<video src="...">` block, into an inline player. A link in the middle of a sentence, in a list item, or in a code block stays a plain link.
- GitHub.com does not render a player for these. Also embed the looping **GIFs** as images (`![before](.../before.gif)`) right above each video line, stacked full-width, each under a bold caption.
- Only a file uploaded through the GitHub comment box gets a player on GitHub.com, and that upload has no API; drag the mp4 in by hand if that is wanted.

## Commits and PRs

- Conventional Commits (`fix(sidepanel): ...`, `feat: ...`, `ci: ...`).
- No `Co-Authored-By` or "generated with" trailers, and no AI tool names, in commit messages or PR descriptions.
- Say in the PR what was **not** verified.
- Branch from `main`, open a PR, do not push directly to `main` once the project has other contributors.

## Privacy and security

- No secrets in the repo. The manifest `key` is a public key that only pins the extension ID.
- The companion listens on loopback only. Do not widen the Host/Origin checks in `src/companion/http.ts` without a test and a note in `docs/SPEC.md`.
- Keep the extension local-first: no network calls except to the user's own companion on `127.0.0.1`.
