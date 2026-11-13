import type { TimeRef } from './schema';

/** "01:05.40", or "1:02:03.50" for >= 1h. Centisecond precision. */
export function formatSeconds(seconds: number): string {
  const total = Math.max(0, seconds);
  const cs = Math.round(total * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${h > 0 ? `${h}:${pad(m)}` : pad(m)}:${pad(s)}.${pad(c)}`;
}

/** "00:12.40 · frame 372" when a frame is known. */
export function formatTime(t: TimeRef | null | undefined): string {
  if (!t) return '';
  return t.frame !== undefined ? `${formatSeconds(t.seconds)} · frame ${t.frame}` : formatSeconds(t.seconds);
}

export function frameToSeconds(frame: number, fps: number): number {
  return frame / fps;
}

export function parseFps(text: string | null | undefined): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*fps/i.exec(text ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Studio "MM:SS.FF" (FF = frames) -> frame number at fps. */
export function remotionTimecodeToFrame(text: string, fps: number): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const [, h, mm, ss, ff] = m;
  return ((Number(h ?? 0) * 60 + Number(mm)) * 60 + Number(ss)) * Math.round(fps) + Number(ff);
}
