import type { MediaFile } from "./scan.ts";

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

export interface SizeRange {
  /** Inclusive lower bound in bytes, or undefined for no bound. */
  min?: number;
  /** Inclusive upper bound in bytes, or undefined for no bound. */
  max?: number;
}

export interface ParseResult {
  range?: SizeRange;
  error?: string;
}

/**
 * Parse a size expression into bytes.
 *
 * Accepts `500mb`, `1.5 gb`, `2GiB`, or a bare number meaning megabytes
 * (the unit a human picks a video size in).
 */
export function parseSize(input: string): { bytes?: number; error?: string } {
  const text = input.trim().toLowerCase();
  if (!text) return { error: "empty" };

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/.exec(text);
  if (!match) return { error: `not a size: "${input}"` };

  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value) || value < 0) return { error: `not a positive number: "${input}"` };

  const unit = match[2] ?? "mb";
  const bytes = value * UNITS[unit]!;
  if (!Number.isSafeInteger(Math.round(bytes))) return { error: `size too large: "${input}"` };
  return { bytes: Math.round(bytes) };
}

/**
 * Parse a range expression. Supported forms:
 *
 *   (empty)          no bound
 *   `500mb`          min only
 *   `500mb-2gb`      both bounds
 *   `>500mb`         min only
 *   `<2gb`           max only
 */
export function parseSizeRange(input: string): ParseResult {
  const text = input.trim().toLowerCase();
  if (!text) return { range: {} };

  // Open-ended forms: "1gb-" is a minimum, "-800mb" is a maximum. These are
  // common enough that rejecting them just pushes people to type ">1gb" instead.
  if (text.endsWith("-") && text.length > 1) {
    const parsed = parseSize(text.slice(0, -1));
    if (parsed.bytes === undefined) return { error: parsed.error ?? "bad minimum" };
    return { range: { min: parsed.bytes } };
  }
  if (text.startsWith("-") && text.length > 1) {
    const parsed = parseSize(text.slice(1));
    if (parsed.bytes === undefined) return { error: parsed.error ?? "bad maximum" };
    return { range: { max: parsed.bytes } };
  }

  if (text.startsWith(">")) {
    const parsed = parseSize(text.slice(1));
    if (parsed.bytes === undefined) return { error: parsed.error ?? "bad minimum" };
    return { range: { min: parsed.bytes } };
  }

  if (text.startsWith("<")) {
    const parsed = parseSize(text.slice(1));
    if (parsed.bytes === undefined) return { error: parsed.error ?? "bad maximum" };
    return { range: { max: parsed.bytes } };
  }

  const dash = findRangeSeparator(text);
  if (dash === -1) {
    const parsed = parseSize(text);
    if (parsed.bytes === undefined) return { error: parsed.error ?? "bad size" };
    return { range: { min: parsed.bytes } };
  }

  const lo = parseSize(text.slice(0, dash));
  const hi = parseSize(text.slice(dash + 1));
  if (lo.bytes === undefined) return { error: lo.error ?? "bad minimum" };
  if (hi.bytes === undefined) return { error: hi.error ?? "bad maximum" };
  if (lo.bytes > hi.bytes) return { error: "minimum is larger than maximum" };
  return { range: { min: lo.bytes, max: hi.bytes } };
}

/**
 * Find the `-` that separates two sizes.
 *
 * The character before it may be a unit letter (`200mb-2gb`), not just a digit,
 * so require only that the right side starts with a number. Unit-less forms like
 * `700-900` work through the same check.
 */
function findRangeSeparator(text: string): number {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] !== "-") continue;
    const before = text[i - 1]!;
    const after = text[i + 1];
    if (!after) continue;
    if (!/[a-z0-9]/.test(before)) continue;
    if (!/\d/.test(after)) continue;
    return i;
  }
  return -1;
}

export function matchesRange(size: number, range: SizeRange): boolean {
  if (range.min !== undefined && size < range.min) return false;
  if (range.max !== undefined && size > range.max) return false;
  return true;
}

export function filterBySize(files: readonly MediaFile[], range: SizeRange): MediaFile[] {
  if (range.min === undefined && range.max === undefined) return [...files];
  return files.filter((f) => matchesRange(f.size, range));
}

/**
 * Human summary of a folder's contents, e.g. "7 videos · 3.4 GiB total".
 * Takes the noun from the caller so book and audio scans don't claim to have
 * found videos.
 */
export function describeLibrary(
  files: readonly { size: number }[],
  noun = "video",
): string {
  if (files.length === 0) return "no files";
  let total = 0;
  for (const file of files) total += file.size;
  const plural = files.length === 1 ? noun : `${noun}s`;
  return `${files.length} ${plural} · ${formatBytes(total)} total`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}
