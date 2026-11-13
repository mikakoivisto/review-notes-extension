// zod-free constants so the content script / overlay stay small.
export const NOTE_TYPES = ['visual', 'timing', 'sound', 'text', 'general'] as const;
export const NOTE_STATUSES = ['open', 'in_progress', 'fixed', 'wontfix'] as const;
export const ADAPTER_IDS = ['remotion', 'youtube', 'html5-video', 'generic', 'none'] as const;
export type ScreenshotKind = 'annotated' | 'clean';

export function screenshotPath(id: string, kind: ScreenshotKind): string {
  return kind === 'clean' ? `screenshots/${id}.clean.png` : `screenshots/${id}.png`;
}
