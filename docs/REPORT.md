# Build report — Review Notes Extension

**Result:** the MVP works end to end in automation, but **four things were never run by a human or a test** — verify them first:
1. The **toolbar button**, the **`Alt+Shift+N` shortcut** and the browser's **real side panel** (`chrome.sidePanel.open`). Playwright cannot
   drive them; the same panel page is tested as a popup window instead.
2. **T3 Code's own MCP settings screen** — only the Claude Code / Codex harness configs (README) are documented, not T3's UI.
3. **Screenshots on `chrome://` pages after a real toolbar invocation** (activeTab). From the panel button Chrome refuses it (tested).
4. Anything on **Windows/Linux or other Chromium browsers** — only macOS + Playwright's Chromium 158 were used.

Everything else is on branch `build/review-notes-extension` (three commits plus this fix commit; **nothing pushed, `main` untouched**).
Unit/integration **81/81**, end-to-end **14/14** (real Chromium + unpacked extension, real Remotion Studio, real YouTube), demo recorded.

## What was built
- **Extension** (MV3, TypeScript, esbuild): on-demand injection, Shadow-DOM overlay (pen, arrow, box, circle, text, pin, eraser,
  colours, undo/redo), screenshots via `captureVisibleTab` cropped to the video picture (annotated + clean), black-frame
  warning, IndexedDB store, side panel (list, status filter, edit, delete, click-to-seek), options, zip export/import
  (`notes.json` + `notes.md` + PNGs).
- **Adapters**: HTML5 video, YouTube, Remotion Studio (live frame, fps, composition, seek via a MAIN-world bridge), page fallback.
- **Companion** (Node): file store (`notes.json`, `notes.md`, `screenshots/`), Host/Origin-checked HTTP sync API, **MCP over stdio and
  streamable HTTP** — `list_notes`, `get_note`, `get_screenshot`, `update_note_status`, `mark_fixed`, `claim_notes`.
- **Docs**: `docs/SPEC.md` (spec + §12 findings), `docs/note.schema.json`, `README.md` (install, Claude Code/T3 Code MCP setup).

## Test results
| Suite | Command | Result |
|---|---|---|
| Unit + companion + MCP (Vitest) | `npm test` | **81 passed**, 0 failed |
| E2E (Playwright, unpacked extension) | `npm run test:e2e` | **14 passed**, 0 failed, 0 skipped |
| Demo | `node scripts/record-demo.mjs` | 1 passed |

E2E covers: video note flow with seek-back, strict-CSP page, black (DRM-like) video, plain page with scroll restore,
screenshot-only fallback + unsupported-page message, filter/edit/delete, **service-worker kill/restart**, export → delete → import,
companion sync + MCP client `list_notes`/`get_screenshot`/`mark_fixed` + panel shows the agent's reply, companion offline,
**Remotion Studio** (frame read while paused and playing, seek back through the bridge, **click-to-seek while the preview is playing**), **YouTube** (real network; the test skips
itself on no network, consent wall or ads).
MCP is tested with an in-memory client, a **real stdio process** and a **real HTTP daemon** (cross-process file visibility).

Bugs the tests caught and that are fixed: `Origin` missing on extension GETs (sync would never have worked), drawing/controls
defeating black-frame detection, tombstones blocking re-import, an empty-list message typo, **Remotion seek failing while the preview
plays** (the adapter now pauses first), and docs that recommended "Screenshot note" for `chrome://` pages (Chrome refuses it there).

## Demo
- `demo/demo.webm` (VP9) and `demo/demo.mp4` (H.264) — 33 s, page window and notes-panel window side by side.
- Stills: `demo/00-paused-video.png`, `02-annotation.png`, `05-seek-back-with-ghost.png`, `10-drawing-tools.png`,
  `11-note-with-screenshot-and-timecode.png`, `12-before-seek.png`, `13-export.png`, `14-mcp-list-notes.png`, `15-agent-marked-fixed.png`;
  `demo/demo-export.zip` is the real export; `demo/timeline.json` has the milestone times.
- Flow: open video → play → pause at 3 s → draw box/arrow/text → add note → panel shows screenshot + timecode → move video, click note →
  seeks back with the ghost drawing → export → **real MCP client** `list_notes` / `get_screenshot` / `mark_fixed` (rendered in a console page) → panel shows "Fixed" + reply.
- Honest notes: the two windows are separate recordings stitched with ffmpeg; the yellow dot is an injected fake mouse pointer (hidden
  during screenshots); the "MCP console" is a page that displays the real output of the test's MCP calls.

## Known limitations
- **Not exercised** — see the list at the top (toolbar button, shortcut, real side panel, T3 Code UI, other OSes).
- **Local API trust**: `/api` accepts `Sec-Fetch-Site: none` GETs, so another *installed browser extension* with localhost access could read
  your notes from the companion. Web pages cannot (Host/Origin/Sec-Fetch checks). Mitigation if needed: an optional shared token.
- **Remotion** depends on undocumented Studio internals, verified on 4.0.543 only; no seek fallback without the bridge.
- Top-frame videos only (no cross-origin iframes); review mode is not restored after a page reload (press the icon again).
- DRM video: screenshots are black (flagged, note + timecode kept). Black detection cannot tell a legitimately black frame from DRM.
- Sync is per-note last-writer-wins; concurrent text edit + agent status change can lose one side.
- One store per companion process; no native messaging; bundles carry zod (~440 KB); no Web Store packaging.
- Test video clock: the burned-in `testsrc2` timer is not frame-exact against `currentTime` (±0.2 s), irrelevant to the assertions.

## Next steps
1. Hand-verify toolbar click, shortcut and the real side panel; add a manual checklist.
2. Persist review mode across navigations; iframe support (embedded YouTube/Vimeo).
3. Field-level sync merge; project routing (several stores by URL pattern).
4. More adapters (Vimeo, Frame.io-style players), Remotion version matrix in CI.
5. Native-messaging transport, `zod/mini`, Web Store packaging with optional host permissions.
