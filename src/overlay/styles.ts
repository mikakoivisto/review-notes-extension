export const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
canvas { position: fixed; pointer-events: none; touch-action: none; }
canvas.draw.on { pointer-events: auto; cursor: crosshair; }
canvas.draw.on.eraser { cursor: cell; }
canvas.draw.on.text { cursor: text; }
.anchor-frame { position: fixed; pointer-events: none; outline: 1px dashed rgba(59,130,246,.7); }
.toolbar { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; gap: 4px; align-items: center;
  background: rgba(17,24,39,.94); color: #f9fafb; padding: 6px 8px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.45); font-size: 12px; user-select: none; max-width: calc(100vw - 16px); flex-wrap: wrap; }
.toolbar[hidden], .composer[hidden], .toast[hidden], canvas[hidden], .anchor-frame[hidden] { display: none !important; }
.toolbar button { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 6px; font-size: 12px; line-height: 16px; color: #f9fafb; border: 1px solid transparent; white-space: nowrap; }
.toolbar button:hover:not(:disabled) { background: rgba(255,255,255,.14); }
.toolbar button.active { background: #2563eb; border-color: #60a5fa; }
.toolbar button:disabled { opacity: .35; cursor: default; }
.toolbar .sep { width: 1px; align-self: stretch; background: rgba(255,255,255,.2); margin: 0 2px; }
.toolbar .grip { cursor: grab; padding: 0 4px; opacity: .6; }
.swatch { width: 16px; height: 16px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.swatch.active { border-color: #fff; outline: 1px solid #2563eb; }
.time { font-variant-numeric: tabular-nums; background: rgba(255,255,255,.1); padding: 3px 8px; border-radius: 6px; min-width: 120px; text-align: center; }
.time.warn { background: #b45309; }
.primary { background: #16a34a !important; font-weight: 600; }
.composer { position: fixed; top: 64px; left: 50%; transform: translateX(-50%); pointer-events: auto; width: min(420px, calc(100vw - 24px));
  background: #111827; color: #f9fafb; border-radius: 12px; padding: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.55); display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.composer textarea { width: 100%; min-height: 84px; resize: vertical; border-radius: 8px; border: 1px solid #374151; background: #1f2937; color: #f9fafb; padding: 8px; font-size: 14px; font-family: inherit; }
.composer select { background: #1f2937; color: #f9fafb; border: 1px solid #374151; border-radius: 6px; padding: 4px 6px; }
.composer .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.composer button { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 6px; background: #374151; color: #fff; font-size: 13px; }
.composer button.save { background: #16a34a; font-weight: 600; }
.composer .meta { color: #9ca3af; font-size: 12px; }
.composer .warn { color: #fbbf24; font-size: 12px; }
.toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: #111827; color: #f9fafb; padding: 8px 14px; border-radius: 8px; pointer-events: none; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.45); max-width: 80vw; }
.toast.warn { background: #92400e; }
.text-input { position: fixed; pointer-events: auto; background: rgba(0,0,0,.65); color: #fff; border: 1px solid #60a5fa; border-radius: 6px; padding: 4px 8px; font-size: 16px; min-width: 140px; }
:host([data-capturing]) .toolbar, :host([data-capturing]) .composer, :host([data-capturing]) .toast, :host([data-capturing]) .anchor-frame { display: none !important; }
`;
