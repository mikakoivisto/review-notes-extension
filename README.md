# Review Notes Extension

A Chromium (Manifest V3) extension for **reviewing videos and web pages**: timestamped notes, drawing on top of
the picture, screenshots — and a small local **companion** that hands the notes to AI agents (Claude Code,
T3 Code, any MCP client) so they can read them, look at the screenshots and mark them fixed.

- **Adapters**: generic HTML5 `<video>`, YouTube, Remotion Studio (frame-accurate), plus a page fallback.
- **Overlay**: pen, arrow, box, circle, text, pin, eraser, colours, undo/redo — anchored to the video picture.
- **Notes panel**: filter by status, click a note to seek back, edit/delete, export/import (zip: JSON + Markdown + PNGs).
- **MCP**: `list_notes`, `get_note`, `get_screenshot`, `update_note_status`, `mark_fixed`, `claim_notes` (stdio + HTTP).
- **Local-first**: nothing leaves your machine unless you turn on companion sync (and that only talks to `127.0.0.1`).

Design details: [docs/SPEC.md](docs/SPEC.md) · JSON schema: [docs/note.schema.json](docs/note.schema.json)

## Install (load unpacked)

Requires a Chromium-based browser (Chrome, Edge, Brave, Chromium ≥ 116).

**From a release (no Node needed):** download `review-notes-extension-vX.Y.Z.zip` from the repo's Releases page, unzip it,
open `chrome://extensions`, enable Developer mode, **Load unpacked**, pick the unzipped folder.

**From source** (needs Node ≥ 20):

```bash
npm install
npm run build          # -> dist/extension, dist/companion
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `dist/extension`.
3. Open any page with a video, click the toolbar icon (or press **Alt+Shift+N**). The side panel opens and the
   review toolbar appears on the page.

The extension id is pinned (`aaghkaonkmldbheimamdknhdgjcmjhfk`) so the companion can authenticate it.

## Using it

1. **Pause** the video where the problem is (the toolbar shows the timecode/frame).
2. Pick a tool and draw. Esc (or **✋ Interact**) lets you click the player again.
3. **＋ Add note** → write the text, choose a type (visual/timing/sound/text/general), **Save note**.
4. The note appears in the side panel with the screenshot (cropped to the video) and the timecode.
   Click it (or **⏵ Go to**) to seek back and see your drawing again.
5. **Export zip** gives `notes.json`, `notes.md` and `screenshots/*.png`; **Import…** reads it back.

`chrome://` pages (and other browser-internal pages) can neither be annotated nor captured — Chrome refuses it, and the
panel says so. **Screenshot note** in the panel is a fallback that needs no injection (it only uses
`captureVisibleTab`); it was verified on a normal page, and may help where injection fails but capture is allowed.
Strict-CSP pages are fine: the overlay does not depend on inline styles. DRM-protected video produces a black
screenshot: the note keeps the timecode and drawing and the panel shows a warning.

> The panel is the browser's side panel. It can also be opened as a normal window (**⧉** button).

## Companion + MCP

The companion mirrors your notes to files (`notes.json`, `notes.md`, `screenshots/`) and exposes them over MCP.

```bash
# default store: ~/.review-notes   (or --dir /path/to/project/.review-notes to keep notes inside a project)
node dist/companion/cli.js serve               # HTTP on 127.0.0.1:47821 (extension sync + MCP over HTTP)
node dist/companion/cli.js print-config        # ready-to-paste MCP client config
```

In the extension: **⚙ Settings → Sync notes with the companion**, URL `http://127.0.0.1:47821`.
Agent changes (`mark_fixed`) show up in the panel on the next sync (focus, change, or every minute).

The notes are plain files, so even without MCP an agent can just read `<project>/.review-notes/notes.md`.

### Claude Code

```bash
# stdio (the agent starts it; no daemon needed; reads the same files the daemon writes)
claude mcp add review-notes -- node /ABS/PATH/dist/companion/cli.js mcp --dir ~/.review-notes

# or HTTP (needs `serve` running)
claude mcp add --transport http review-notes http://127.0.0.1:47821/mcp
```

Then: *"Fix the open review notes"* — the agent calls `list_notes`, `get_screenshot`, edits the code, and calls
`mark_fixed` with a one-sentence reply.

### T3 Code (and other MCP clients)

T3 Code drives the Claude Code / Codex harnesses, so the configuration of the harness you pick applies:
a project-level `.mcp.json` for Claude Code,

```json
{ "mcpServers": { "review-notes": { "command": "node", "args": ["/ABS/PATH/dist/companion/cli.js", "mcp", "--dir", "/ABS/PATH/project/.review-notes"] } } }
```

or, for Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.review-notes]
command = "node"
args = ["/ABS/PATH/dist/companion/cli.js", "mcp", "--dir", "/ABS/PATH/project/.review-notes"]
```

Any other MCP client: use the stdio command above, or the streamable-HTTP URL `http://127.0.0.1:47821/mcp`.
(T3 Code's own MCP settings screen has not been verified here — the harness config above is what we tested against,
see the report in `docs/REPORT.md`.)

### Tools

| Tool | What |
|------|------|
| `list_notes` | open notes by default; filters `status`, `url`, `type`, `adapter`, `limit` |
| `get_note` | full details by id or `#seq` |
| `get_screenshot` | PNG as MCP image content (annotated or clean) + file path |
| `update_note_status` / `mark_fixed` | set status (`open`, `in_progress`, `fixed`, `wontfix`) with a short reply |
| `claim_notes` | mark open notes `in_progress` ("I'm on it") |

## Remotion Studio

Works on `http://localhost:3000/<composition>` (Remotion Studio). It reads the frame and fps from the Studio UI and
seeks with Remotion's `remotion_setFrame`. **This relies on undocumented Studio internals** (verified on Remotion
4.0.543, see [SPEC §5.3](docs/SPEC.md)); a Remotion upgrade may break it. A sample project is in
`examples/remotion-sample` (`cd examples/remotion-sample && npm install && npm run studio`).

## Development

```bash
npm run typecheck
npm test               # unit + companion + MCP tests (Vitest)
npm run test:e2e       # builds, then Playwright with the unpacked extension (needs Playwright Chromium)
npm run schema         # regenerate docs/note.schema.json
```

Layout: `src/adapters` (site adapters), `src/overlay` (drawing engine + UI), `src/content` (content script +
MAIN-world bridge), `src/background` (service worker, sync), `src/sidepanel`, `src/options`, `src/companion`
(store, HTTP, MCP, CLI), `src/shared` (schema, db, zip, markdown, …). To add an adapter: one file in
`src/adapters`, one line in `src/adapters/index.ts`, one fixture test.

## Privacy

Notes and screenshots stay in the browser's IndexedDB. The extension injects nothing until you start a review on
a tab, has no analytics and loads no remote code. With sync enabled it talks only to the companion on `127.0.0.1`
(Host- and Origin-checked). Screenshots can contain sensitive page content — export and sync are explicit actions.

## Known limitations

See the end of the report / SPEC §3.6 and §11: top-frame videos only (no cross-origin iframes), DRM screenshots are
black, per-note last-writer-wins sync, Remotion internals are undocumented, bundles include zod (~450 KB).

## License

[MIT](LICENSE)
