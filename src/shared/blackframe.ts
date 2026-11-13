/**
 * DRM-protected video (Widevine/EME) screenshots come back solid black. We cannot tell a legitimately black
 * frame from a protected one, so we only *flag*: mean luminance ~0 with ~zero variance.
 */
export function isSuspectedBlack(rgba: Uint8ClampedArray | Uint8Array, opts = { meanMax: 3, varMax: 4 }): boolean {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return false;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    sum += l;
    sumSq += l * l;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return mean < opts.meanMax && variance < opts.varMax;
}
