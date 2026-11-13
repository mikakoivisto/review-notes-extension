# Review Notes Extension — Specification

Status: v0.1 (Phase 1). Source of truth for the MVP in Phase 2.

---

## 1. Goals and non-goals

### Goals
1. Review **any video or web page** in a Chromium browser: timestamped notes, drawing on top of the page or
   video, screenshots.
2. **Site adapters** that detect the media/preview and read (and, where possible, seek) the current timecode:
   generic HTML5 `<video>`, YouTube, Remotion Studio. New adapters are cheap to add.
3. **Annotation overlay**: pen, arrow, box, circle, text, pin, eraser, colour, undo/redo; anchored to the
   video's picture rectangle when a video is detected, otherwise to the viewport.
4. **Side panel** with the notes list: click a note → seek back to its timestamp; filter by status; edit/delete.
5. **Portable data**: export/import as JSON + Markdown with screenshot files.
6. **Hand-off to AI agents**: a small local Node companion exposing an **MCP server** (stdio and streamable HTTP)
   so Claude Code, T3 Code or any MCP client can `list_notes`, `get_note`, `get_screenshot`, `mark_fixed`.
   Optional zero-setup path: notes are mirrored as files in a project folder (`.review-notes/`).
7. **Local-first and private**: nothing leaves the machine unless the user sends it somewhere.
8. **Degrade gracefully**: DRM video (black screenshots), strict-CSP pages, pages we cannot inject into.

### Non-goals (MVP)
- Cloud sync, accounts, multi-user collaboration, comments threads between humans.
- Video editing or rendering, frame-accurate scrubbing UI of our own.
- Firefox/Safari (Chromium MV3 only; code avoids Chromium-only APIs where cheap).
- Videos inside cross-origin `<iframe>`s (top frame only; see open questions).
- Recording screen/video clips (screenshots only).
- Chrome Web Store packaging and signing.
- Native messaging transport (spec'd as future work, §6.4).

---

## 2. User stories

| # | As a… | I want to… | So that… |
|---|-------|-----------|----------|
| U1 | reviewer | pause a video, draw on the frame and write "logo too small" | the editor sees exactly what I mean |
| U2 | reviewer | have the current timecode (or frame) captured automatically | I never type timestamps |
| U3 | reviewer | click a note and have the video jump to that moment | I can re-check a fix quickly |
| U4 | reviewer | review a Remotion Studio preview by frame number | notes map to code (`frame 372`) |
| U5 | reviewer | annotate a normal web page (no video) | the tool is useful for UI review too |
| U6 | reviewer | filter notes by status and mark them fixed/open | I track what remains |
| U7 | reviewer | export notes + screenshots as a zip (JSON + Markdown) and import it elsewhere | I can share or archive a review |
| U8 | developer using an AI agent | tell the agent "fix the review notes" and have it read them directly via MCP | no copy/paste |
| U9 | developer | have the agent mark notes fixed with a short reply, and see that in the panel | closing the loop |
| U10 | developer | mirror notes into my project (`.review-notes/notes.json`) | any agent can read them with zero setup |
| U11 | reviewer on a DRM site | be told that the screenshot is black, and still keep the note + timecode | I am not silently given a useless image |
| U12 | reviewer on a strict-CSP page | still capture a note with a screenshot | the tool never "just fails" |

---

## 3. Architecture

```
┌────────────────────────── Chromium ──────────────────────────────┐
│                                                                  │
│  Web page (any site)                                             │
│  ┌──────────────────────────┐   ┌─────────────────────────────┐  │
│  │ MAIN-world bridge        │◄─►│ Content script (isolated)   │  │
│  │ (Remotion seek only)     │pm │  • adapter registry         │  │
│  └──────────────────────────┘   │  • overlay (Shadow DOM)     │  │
│                                 │  • drawing engine + toolbar │  │
│                                 └──────────────┬──────────────┘  │
│                                    runtime msgs│                 │
│  ┌──────────────────────┐        ┌─────────────▼──────────────┐  │
│  │ Side panel (list UI) │◄──────►│ Service worker (stateless) │  │
│  └──────────┬───────────┘        │  • notes API over IndexedDB│  │
│             │ direct             │  • captureVisibleTab + crop│  │
│             ▼                    │  • injection, commands     │  │
│        IndexedDB  ◄──────────────┤  • companion sync          │  │
│  (notes + screenshot blobs)      └─────────────┬──────────────┘  │
└────────────────────────────────────────────────┼─────────────────┘
                                                 │ HTTP 127.0.0.1:47821 (Origin-checked)
┌────────────────────────────────────────────────▼─────────────────┐
│ Companion (Node)                                                 │
│  • HTTP API for the extension (/api/*)                           │
│  • MCP streamable HTTP (/mcp)          • MCP stdio (`mcp` cmd)   │
│  • File store: <dir>/notes.json + <dir>/screenshots/*.png        │
└──────────────────────────────────────────────────────────────────┘
        ▲ stdio / HTTP MCP clients: Claude Code, T3 Code, any MCP client
```

### 3.1 Components

**Service worker (background)** — MV3, event-driven, **holds no in-memory state** (it can be killed at any
time). Everything it needs is in IndexedDB / `chrome.storage.session`. Responsibilities:
- Notes API (create/update/delete/list/get, screenshot blobs) over IndexedDB; broadcasts `notes-changed`.
- Injection on demand: `chrome.scripting.executeScript` of the content script (isolated world) and, only for
  adapters that need it, the MAIN-world bridge. No static content scripts → **nothing runs on a page until the
  user starts review on that tab** (privacy + performance).
- Screenshot pipeline (§3.5).
- Keyboard command (`toggle-review`, default `Alt+Shift+N`), action click, side-panel behaviour.
- Companion sync (§6).

**Content script (isolated world)** — one instance per reviewed tab, idempotent (re-injection is a no-op):
- Adapter registry → picks the best adapter and keeps its `AdapterSession`.
- Overlay: a Shadow-DOM host (`position: fixed`, max z-index) with a `<canvas>` for drawing and a small
  toolbar. Styles use constructable stylesheets (`adoptedStyleSheets`) which, unlike inline `<style>`, are not
  subject to the page's CSP `style-src`.
- Drawing engine (pure TS, DOM-free core for unit tests): shapes, hit-testing for eraser, undo/redo stack,
  render to canvas, serialise to normalised vector data.
- Note composer (text, type, status) and the "capture" flow.

**MAIN-world bridge** — a tiny script injected with `world: "MAIN"` *only* when the Remotion adapter matches.
Isolated-world scripts cannot see page globals such as `window.remotion_setFrame`; the bridge exposes them via
`window.postMessage` with a per-session nonce. Reading never needs the bridge.

**Side panel** — extension page (`sidepanel.html`) that lists notes, filters by status, edits/deletes, seeks,
exports/imports, and shows companion status. It talks to IndexedDB directly and to the service worker for
anything touching a tab. **It never assumes "the active tab"**: it is given a `tabId` (`?tabId=` query or the
service worker's last-focused-web-tab record in `chrome.storage.session`). This makes it testable when opened
as an ordinary tab (Playwright cannot drive the real side panel).

**Options page** — companion URL/port, project-folder mirror toggle, default colour/tool, export prefs.

**Companion** — Node ≥ 20, one package, two entry points (`serve`, `mcp`) sharing a file store (§6).

### 3.2 Storage (extension)
- **IndexedDB** database `review-notes` v1:
  - `notes` store (keyPath `id`), indexes `by-url`, `by-status`, `by-updatedAt`.
  - `screenshots` store keyed `"<noteId>/<kind>"` (`annotated` | `clean`), value = `Blob` (PNG).
- `unlimitedStorage` permission so screenshots never hit the quota.
- `chrome.storage.session`: per-tab "review mode on" flag, last-focused-web-tab id, sync cursor.
- `chrome.storage.local`: settings only (small).
- Content scripts never touch IndexedDB (it would be the *page's* origin); they message the service worker.

### 3.3 Messaging
Typed request/response messages over `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`
(`shared/messages.ts`), e.g. `note:create`, `note:update`, `note:delete`, `tab:seek`, `tab:getState`,
`review:start`, `review:stop`, `capture:screenshot`, `notes-changed` (broadcast). Every handler is async and
idempotent where possible.

### 3.4 Review flow
1. User presses the action button / shortcut / "Start review" in the side panel → SW injects the content script.
2. Content script picks an adapter, mounts the overlay, shows the toolbar. Media is paused on first draw
   (configurable; always for Remotion/HTML5 when the user starts drawing).
3. User draws (optional) and presses **Add note** → composer: text, type, → **Save**.
4. Content script gathers: `adapter state` (time/frame/fps), `media descriptor`, `annotation` (normalised),
   `page context` (url, title, scroll, viewport) and asks the SW for a screenshot.
5. SW stores the note + screenshot(s); broadcasts `notes-changed`; the side panel refreshes.
6. Clicking a note in the panel → SW → content script → `adapter.seek(time)` (or restores scroll for pages) and
   shows the saved annotation as a read-only ghost overlay until dismissed.

### 3.5 Screenshot pipeline
- `chrome.tabs.captureVisibleTab` captures **whichever tab is foreground in that window**, so capture is
  **initiated from the content page** (the overlay) and the SW verifies `sender.tab` is active before capturing;
  if not it fails with `TAB_NOT_VISIBLE` rather than capturing the wrong tab.
- Sequence: content script hides the toolbar (keeps annotation canvas) → waits two `requestAnimationFrame`s →
  SW captures **annotated** PNG → (only if shapes exist) content script hides the canvas → SW captures
  **clean** PNG → overlay restored. `captureVisibleTab` is rate limited (~2/s): the SW serialises captures and
  spaces them ≥ 600 ms apart.
- Crop: content script sends the media rect (CSS px, viewport-relative) and `window.innerWidth`; SW computes
  `scale = image.width / innerWidth` (robust against devicePixelRatio and browser zoom), crops with
  `OffscreenCanvas`, and encodes PNG. Falls back to full viewport when no media rect.
- **Black-frame detection**: the cropped image is downsampled to 32×32; if mean luminance < 3/255 and variance
  ≈ 0 *while the media reports it is not at a legitimately black moment* (we cannot know; so we merely flag),
  `screenshot.suspectedBlack = true`. UI shows "Screenshot looks black (DRM-protected or empty frame)". The note
  still keeps timecode and annotation vectors.
- **Fallback mode** (no injection possible — `chrome://`, Web Store, strict-CSP failure, PDF viewer): side panel
  button **Screenshot note** → SW captures the visible tab, creates a note with `adapter: "none"`, no time, no
  annotation. Never blocked by page CSP because it uses extension APIs only.

### 3.6 Failure/degradation matrix
| Situation | Behaviour |
|-----------|-----------|
| DRM video (Widevine/EME) | Screenshot flagged `suspectedBlack`; note + time + vectors kept |
| Page CSP blocks overlay | Constructable stylesheets + Shadow DOM first; if mount still fails, report and offer fallback mode |
| `chrome://`, Web Store, `file://` without permission | Fallback mode (or message explaining why not possible) |
| No media found | Overlay anchors to viewport; notes store scroll + viewport size |
| Media inside cross-origin iframe | Not detected (MVP); page-mode notes work |
| Service worker restarted | No state lost (stateless); content script re-registers on next message |
| Companion not running | Sync badge "offline"; local notes unaffected; retry with backoff |
| Adapter throws | Registry catches, logs, falls back to next adapter (generic) |

---

## 4. Data model

Single source of truth: **zod schemas** in `src/shared/schema.ts`; `docs/note.schema.json` is generated from them
(`npm run schema`). `schemaVersion` is stored on every export/store file; migrations are pure functions
`migrate(vN) → vN+1`.

### 4.1 Note

```ts
type NoteType   = 'visual' | 'timing' | 'sound' | 'text' | 'general';
type NoteStatus = 'open' | 'in_progress' | 'fixed' | 'wontfix';
type AdapterId  = 'remotion' | 'youtube' | 'html5-video' | 'generic' | 'none';

interface Note {
  id: string;                 // ULID-ish, sortable: "01J…"; also the screenshot file stem
  seq: number;                // human-friendly per-store counter, shown as "#12"
  url: string;                // page URL at creation (hash kept, tracking params not stripped)
  pageTitle: string;
  adapter: AdapterId;
  media: MediaDescriptor | null;
  time: TimeRef | null;       // null for page notes
  type: NoteType;
  text: string;
  status: NoteStatus;
  reply?: string;             // agent/developer reply, e.g. "Enlarged logo to 25%"
  annotation: Annotation | null;
  screenshot: ScreenshotRef | null;
  context: PageContext;       // scroll/viewport, always present
  createdAt: string;          // ISO-8601 UTC
  updatedAt: string;          // ISO-8601 UTC (bumped by any edit, incl. agent status changes)
}

interface TimeRef { seconds: number; frame?: number; fps?: number; }
// Remotion: frame is authoritative, seconds = frame / fps. HTML5/YouTube: seconds only.

interface MediaDescriptor {
  kind: 'video' | 'composition';
  durationSeconds?: number;
  width?: number; height?: number;           // intrinsic
  videoId?: string;                          // YouTube id
  compositionId?: string;                    // Remotion
  src?: string;                              // currentSrc for html5 (may be blob:, informational)
}

interface Annotation {
  anchor: 'media' | 'viewport';
  aspect: number;             // width / height of the anchor rect when drawn
  shapes: Shape[];
}
// Coordinates are normalised 0..1 relative to the anchor rect (resolution independent).
// `c` = colour, `sw` = stroke width as a fraction of anchor height, `size` = text height (same unit).
type Shape =
  | { t: 'pen';    c: string; sw: number; pts: [number, number][] }
  | { t: 'arrow';  c: string; sw: number; from: [number, number]; to: [number, number] }
  | { t: 'box';    c: string; sw: number; x: number; y: number; w: number; h: number }
  | { t: 'circle'; c: string; sw: number; x: number; y: number; w: number; h: number } // bounding box of the ellipse
  | { t: 'text';   c: string; size: number; x: number; y: number; text: string }       // (x, y) = text baseline start
  | { t: 'pin';    c: string; x: number; y: number; label?: string };

interface ScreenshotRef {
  annotated: string;          // relative path, "screenshots/<id>.png"
  clean?: string;             // "screenshots/<id>.clean.png" — only when shapes exist
  width: number; height: number;
  crop: 'media' | 'viewport';
  suspectedBlack: boolean;
}

interface PageContext {
  scrollX: number; scrollY: number;
  viewportWidth: number; viewportHeight: number;
  devicePixelRatio: number;
  userAgent?: string;
}
```

Status lifecycle: `open` → `in_progress` (agent took it) → `fixed`
(agent/dev done, with `reply`) | `wontfix`. The reviewer can set any status manually (e.g. back to `open` when
a fix did not work). Editing the note text does not change status.

### 4.2 Interchange files
```
<dir>/notes.json          { "schemaVersion": 1, "exportedAt": "...", "notes": Note[] }
<dir>/notes.md            human/agent-readable rendering (generated, never parsed)
<dir>/screenshots/<id>.png, <id>.clean.png
```
- The **companion store**, the **export zip** and the **project-folder mirror** all use this layout.
- `notes.md`: one section per note — `## #12 · visual · open · 00:12.40 (frame 372)`, URL, text, reply, and
  `![](screenshots/<id>.png)`. Sorted by media time, then creation.
- **Import** accepts a zip or a bare `notes.json`; notes with an existing `id` are merged by `updatedAt`
  (newer wins), others are added; screenshots are matched by path.
- Zip is written with a ~60-line "stored" writer (PNG is already compressed) and read with
  `DecompressionStream('deflate-raw')` for compressed entries, so zips from other tools import too.

---

## 5. Adapter interface

```ts
interface AdapterContext { url: URL; document: Document; window: Window; }

interface MediaState {
  timeSeconds: number;
  frame?: number;             // frame-accurate adapters only
  fps?: number;
  durationSeconds?: number;
  paused: boolean;
}

interface Capabilities { seek: boolean; pause: boolean; frameAccurate: boolean; }

interface AdapterSession {
  readonly capabilities: Capabilities;
  getState(): MediaState | null;               // sync + cheap; null if media vanished
  getMediaRect(): DOMRectReadOnly | null;      // picture rectangle in viewport CSS px (letterbox-aware)
  describe(): MediaDescriptor;
  seek(t: TimeRef): Promise<boolean>;          // resolves true when position verified
  pause(): void;
  subscribe?(cb: () => void): () => void;      // optional change hint (otherwise overlay polls on rAF while visible)
  dispose(): void;
}

interface SiteAdapter {
  readonly id: AdapterId;
  readonly priority: number;                   // highest matching priority wins
  matches(ctx: AdapterContext): boolean;       // cheap URL/DOM sniff, no side effects
  attach(ctx: AdapterContext): AdapterSession | null;
}
```
Registry: `register(adapter)`; `resolve(ctx)` returns the highest-priority adapter whose `matches` and `attach`
succeed. Exceptions are caught and logged and the next adapter is tried. Adding an adapter = one file + one
line in `adapters/index.ts` + a fixture-based unit test.

### 5.1 `html5-video` (priority 10)
- Picks the best `<video>`: visible, largest area, preferring ones with `currentTime > 0`/playing. Re-evaluated
  on each `getState` if the previous one is detached.
- Time = `video.currentTime`; seek = set `currentTime` then await `seeked` (timeout 2 s) and verify within ½ frame.
- Picture rect = element rect minus letterbox derived from `videoWidth/videoHeight` and `object-fit`.
- Shadow DOM: also searches open shadow roots.

### 5.2 `youtube` (priority 50)
- Matches `*.youtube.com/watch|shorts|embed` and `youtu.be` top frames.
- Uses the page's `video.html5-main-video` (falls back to html5 logic) — **reading and seeking go through the
  `<video>` element**, not YouTube's player API, so it works without the MAIN world.
- Descriptor `videoId` from `v=` / path. Rect from `.html5-video-container video`.
- Ads: if `.ad-showing` is on the player, state is marked `adPlaying` and the composer warns (timestamp
  would be an ad's time).
- Fragility: class names are YouTube-internal; fall back to html5 logic if absent.

### 5.3 `remotion` (priority 100) — Remotion Studio preview
Remotion's Studio DOM is **undocumented**. Investigated live against Remotion Studio **4.0.543**
(`npx remotion studio`, `examples/remotion-sample`). Findings:

| Need | Most robust source found | Notes |
|------|--------------------------|-------|
| Is this Remotion Studio? | `window.remotion_isStudio === true` *(main world)* or `document.title` ends with `- Remotion Studio` *(isolated)* | Title check is used first: no MAIN world needed to *match*. |
| **Current frame (live, also while playing)** | `button.__remotion_input_dragger` whose `aria-label` is purely digits → the frame number; `textContent` is `MM:SS.FF` | Updates every tick during playback. Observed: 6, 15, 24 over 3×300 ms at 30 fps. |
| Current frame (paused only) | `localStorage["remotion.time-all"]` → `{"<compositionId>": frame}` | **Stale during playback** (stays at the last pause/seek value); readable from the isolated world. Used as fallback and cross-check when paused. |
| **fps** | `button.__remotion_input_dragger[aria-label="Frame Rate"]` text `30fps` | Parsed with `/(\d+(?:\.\d+)?)\s*fps/`. |
| Duration / size | `aria-label="Duration"` (`MM:SS.FF`, frames at fps), `aria-label="Width"/"Height"` (`1280px`) | |
| Composition id | `location.pathname` (`/Hello`, nested `/Folder/Comp`) minus leading `/` | Also the key in `remotion.time-all`. |
| Picture rect | `.remotion-studio-composition-container` bounding rect | Scaled preview; stable class name in 4.0.543. |
| **Seek** | `window.remotion_setFrame(frame, compositionId)` *(main world only)* | Verified: moves the playhead, updates the preview and `remotion.time-all`. Needs the MAIN-world bridge. No isolated-world fallback is implemented: without the bridge the adapter reports `seek` as failed (reading still works). Studio keyboard shortcuts (`ArrowLeft/Right` = ±1 frame) were observed but are not used because they cannot jump to an arbitrary frame. |
| Pause | `Space` toggles play in the Studio; adapter only presses it when `paused === false` (determined by two differing frame reads 100 ms apart) | Heuristic. |

Resolution order for `getState()`: (1) live dragger `aria-label` frame → (2) parse the `MM:SS.FF` text × fps →
(3) `localStorage` when the first two are unavailable. `frame` is authoritative; `seconds = frame / fps`.

**Fragility (documented, not contractual)**: every selector above is an observed implementation detail of
4.0.543 (`remotion_setFrame` is the hook the headless renderer uses; the `aria-label`/class names are Studio UI).
A Remotion upgrade can break any of them. Mitigations: all Remotion knowledge lives in
`src/adapters/remotion.ts` (+ the tiny bridge); a **fixture test** (`tests/fixtures/remotion-studio-4.0.543.html`)
pins the observed DOM; an **e2e test** runs against a real Studio started from `examples/remotion-sample`
(pinned 4.0.543) so a drift shows up in CI; the adapter logs which strategy answered; if every strategy fails,
`getState()` returns `null` and the registry falls back to `generic` (page note, no timecode). `remotion_setFrame`
behaviour is verified in e2e (seek, then read back from both the Studio DOM and the adapter).

### 5.4 `generic` (priority 0)
No time. Anchor = viewport; notes record scroll + viewport size; "go to" restores scroll.

---

## 6. Companion and MCP

### 6.1 Process model
Single npm package `companion/` (built to `dist/companion/`), binary `review-notes-companion`:

| Command | What |
|---------|------|
| `serve [--dir D] [--port 47821]` | HTTP server on **127.0.0.1 only**: extension API (`/api/*`) + MCP streamable HTTP (`/mcp`) |
| `mcp [--dir D]` | MCP over **stdio** (spawned by the MCP client). Logs to **stderr only** (stdout is the protocol). |
| `print-config` | Prints ready-to-paste MCP config snippets |

`--dir` / `REVIEW_NOTES_DIR`; default `~/.review-notes`. **Project mode**: `--dir <project>/.review-notes` — the
same files are then what agents read from the repo (zero-setup path, no MCP needed).

### 6.2 File store = source of truth
The stdio MCP process spawned by an agent is a *different process* from the HTTP daemon, so state is **files**:
`notes.json` + `screenshots/`. Writes are read-modify-write under a `mkdir`-based lock (stale after 10 s) and
atomic (`write tmp` → `rename`). Both processes therefore see each other's changes.

### 6.3 Extension ⇄ companion sync (HTTP)
Stateless reconciliation — idempotent, safe to run at any time, no cursors:
- `GET /api/health` → `{ ok, version, dir, noteCount }`.
- `GET /api/sync/index` → `{ dir, notes: [{id, updatedAt, shots}], tombstones: [{id, updatedAt}] }`.
- `GET|PUT /api/notes/:id` (note JSON), `DELETE /api/notes/:id` (body `{updatedAt}`; writes a tombstone).
- `GET|PUT /api/notes/:id/screenshot/:kind` (raw PNG; screenshots are immutable, transferred only when missing).
- The extension compares indexes: **per-note last-writer-wins on `updatedAt`**; tombstones propagate deletes.
  Agent changes (`mark_fixed`) bump `updatedAt`, so the next reconcile pulls them. Known race: editing the
  *text* in the panel at the same instant the agent changes *status* can lose one side (field-level merge is
  future work).
- Reconcile runs: after each local change (immediately, best effort), on panel focus, on options "Sync now",
  and every 60 s via `chrome.alarms` while sync is enabled.
- **Security**: bind `127.0.0.1`; reject requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>`
  (DNS rebinding); `/api/*` additionally requires `Origin: chrome-extension://<id>` where the id is pinned by
  the manifest `key` (a web page can never forge `Origin`; non-browser clients are not supported on `/api`).
  `/mcp` accepts requests **without** an `Origin` header (MCP clients) and rejects any browser origin.
  Request body size cap 25 MB (2 MB on `/mcp`).

### 6.4 Native messaging (future)
Would remove the port, but needs a host manifest installed outside the repo (per-OS path) and the extension
id. Deferred: HTTP gives the same capability with zero system installation.

### 6.5 MCP tools

All tools return a human-readable text block and `structuredContent`. Screenshots are returned as MCP
`image` content (base64 PNG) *and* as a file path in the text, so agents can either view them directly or
`Read` the file.

| Tool | Input | Output |
|------|-------|--------|
| `list_notes` | `status?: 'open'\|'in_progress'\|'fixed'\|'wontfix'\|'all'` (default `open`), `url?: string` (substring), `type?`, `adapter?`, `limit?` | compact list: `#seq id status type time url text` |
| `get_note` | `id: string \| number` (id or `#seq`) | full note JSON + timecode/frame description |
| `get_screenshot` | `id`, `kind?: 'annotated'\|'clean'` (default annotated) | image content + absolute file path |
| `update_note_status` | `id`, `status`, `reply?` | updated note |
| `mark_fixed` | `id`, `reply?` | shortcut: `status = fixed` |
| `claim_notes` | `ids?: string[]` (default: all open) | marks them `in_progress`, returns them ("take") |

Resources: `review-notes://notes` (notes.md), `review-notes://screenshots/<id>`. (Optional in MVP.)

### 6.6 Client setup (also in README)
- Claude Code: `claude mcp add review-notes -- node /abs/path/dist/companion/cli.js mcp --dir ~/.review-notes`
  (or project-scoped `.mcp.json`); or HTTP: `claude mcp add --transport http review-notes http://127.0.0.1:47821/mcp`.
- T3 Code / generic: stdio command + args, or the HTTP URL, in the client's MCP settings.

---

## 7. Permissions and privacy

| Permission | Why |
|------------|-----|
| `host_permissions: <all_urls>` | on-demand injection and `captureVisibleTab` on any site (`activeTab` alone is insufficient: it needs a user gesture on the toolbar button, which also breaks keyboard/side-panel flows and automated tests) |
| `scripting` | on-demand injection (isolated + MAIN world) |
| `sidePanel` | notes list |
| `storage`, `unlimitedStorage` | settings, session flags, screenshot blobs |
| `tabs` | tab ids/urls for seek routing |
| `alarms` | periodic companion pull |
| `commands` (manifest key) | keyboard shortcut |

Privacy statement (also in README and options page):
- **Local-first**: notes and screenshots live in the browser's IndexedDB. Nothing is sent anywhere by default.
- The only network traffic is to `127.0.0.1` (companion) **if the user enables sync**. No analytics, no remote code.
- Screenshots may contain sensitive page content: the panel shows a clear "synced to companion" indicator;
  export is an explicit user action.
- No static content scripts: the extension does nothing on a page until review is started on that tab.
- The repo contains no secrets; the manifest `key` is a *public* key used only to pin the extension id.

---

## 8. Testing strategy

| Layer | Tooling | What |
|-------|---------|------|
| Unit | Vitest (+ happy-dom for DOM) | schema/validation, time formatting, drawing engine (shapes, eraser, undo/redo, normalisation), export/import round trip, zip writer/reader, Markdown rendering, adapters against fixtures (HTML5 stub, YouTube DOM, **Remotion Studio DOM fixture**), file store + lock, HTTP Origin/Host checks |
| MCP | `@modelcontextprotocol/sdk` client over **stdio** and **streamable HTTP** | tools/list, list_notes, get_note, get_screenshot (image content), mark_fixed, claim_notes; cross-process visibility |
| E2E | Playwright, `launchPersistentContext` with `--disable-extensions-except/--load-extension`, `channel: 'chromium'` (full Chromium; the headless shell cannot load extensions) | local page with `<video>`; strict-CSP page; real **Remotion Studio** (`examples/remotion-sample`, started by Playwright `webServer`, torn down automatically); **YouTube** (skipped gracefully on no network/consent wall); the notes panel opened as a separate **popup window** (`chrome.windows.create`) with `?tabId=`, so both pages are visible and each tab stays foreground in its own window |
| Demo | Playwright `recordVideo` on the page window and the panel window, stitched side-by-side by ffmpeg | §9 |

Test constraints designed in up front:
- Playwright **cannot click the toolbar action nor drive the real side panel** → `host_permissions` +
  programmatic start (message the SW) and side panel as a tab with an explicit tab id.
- Playwright's Chromium has **no H.264/AAC** → the test video is generated as **VP9/WebM** with ffmpeg (burned-in
  timecode via `testsrc2`), committed under `tests/fixtures/` (small).
- `recordVideo` records pages, not browser chrome → demo records page + panel pages and stitches.
- DRM black frame cannot be reproduced → unit-test the black detector on synthetic pixel data.
- Service-worker state: tests kill/restart the SW (`chrome://serviceworker-internals` is not scriptable; use
  `serviceWorker.evaluate` to close clients or the CDP `ServiceWorker.stopAllWorkers`) to prove statelessness.

---

## 9. Demo (Phase 3 deliverable)
Scripted flow (single Playwright test): open video page → pause at a known frame → draw (box + arrow + text) →
add note → panel shows note with screenshot and timecode → move the video elsewhere, click the note → video seeks
back → export zip → MCP client `list_notes` (HTTP, against the running companion) returns the note.
Output: `demo/demo.webm` (+ `demo/demo.mp4` via ffmpeg) and `demo/*.png` screenshots.

---

## 10. Milestones
| M | Scope | Exit criterion |
|---|-------|----------------|
| M0 | This spec | committed |
| M1 | Build, manifest, schema, store (IndexedDB), adapters (html5, youtube, remotion), unit tests | `npm test` green |
| M2 | Overlay, drawing engine, composer, screenshot pipeline | e2e: note with screenshot on test video page |
| M3 | Side panel: list, filter, seek, edit/delete, export/import | e2e: click-to-seek |
| M4 | Companion: file store, HTTP API, sync, MCP stdio + HTTP | MCP client test green |
| M5 | Remotion e2e, YouTube e2e (optional), demo recording | report |
| M6 (later) | More adapters, iframe support, native messaging, field-level merge, Web Store packaging | — |

---

## 11. Open questions
1. **Iframe media** (embedded YouTube/Vimeo in other sites): inject `all_frames` + coordinate frame→top overlay?
   Needs a per-frame adapter and a cross-frame message path. Deferred.
2. **Single store vs. per-project routing**: should notes carry a `project` tag so one companion can route to
   several project folders (by URL pattern)? MVP: one `--dir` per companion process.
3. **Field-level merge** for sync (status/reply from agent vs. text from reviewer) instead of per-note LWW.
4. **Persisting review mode across navigations** (re-inject on `tabs.onUpdated`): needs a per-tab flag;
   included only if cheap in M2.
5. **File System Access API** as a *companion-free* project-folder mirror (needs a user gesture and permission
   re-grants per session) — worth it as an alternative to the companion for the zero-setup path?
6. **Remotion versions**: how far back/forward do the observed selectors hold? Needs a version matrix in CI.
7. **Frame vs. seconds for non-Remotion players**: expose a frame number from assumed fps (24/25/30)? Risky; MVP stores seconds only.
8. **Screenshot of cross-origin video** that taints canvas: not an issue for `captureVisibleTab` (it captures
   pixels), but we should confirm behaviour with hardware-overlay video on macOS/Windows.
9. **MCP auth for the HTTP endpoint**: Host/Origin checks only, or an optional bearer token for shared machines?
10. **Distribution**: Chrome Web Store review of `<all_urls>`; consider optional host permissions at first run.
