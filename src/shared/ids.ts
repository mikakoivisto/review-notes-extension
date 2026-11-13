const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Sortable id: 9 chars of base36 millisecond time + 8 random chars. */
export function newId(now: number = Date.now(), rnd: () => number = Math.random): string {
  const t = now.toString(36).padStart(9, '0');
  let r = '';
  for (let i = 0; i < 8; i++) r += ALPHABET[Math.floor(rnd() * 36)];
  return t + r;
}
