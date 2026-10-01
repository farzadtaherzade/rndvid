import * as clack from "@clack/prompts";

import { formatBytes } from "./filters.ts";

export { formatBytes };
export const { intro, outro, log, note, spinner, text, confirm, isCancel } = clack;

function sgr(open: number, close: number) {
  return (text: string | number): string => `\u001B[${open}m${text}\u001B[${close}m`;
}

/**
 * Minimal ANSI styling. Values are functions rather than a lookup table of codes
 * so call sites compose freely: `color.cyan(color.bold("x"))`.
 */
export const color = {
  reset: sgr(0, 0),
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  bgCyan: sgr(46, 49),
  black: sgr(30, 39),
  white: sgr(37, 39),
  bgRed: sgr(41, 49),
} as const;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

export function displayWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Pad to `width` visible columns, ignoring escape codes. */
export function padTo(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** Shorten to `max` visible columns, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  if (max <= 1) return "…";
  return stripAnsi(text).slice(0, max - 1) + "…";
}

export function relativeTime(timestampMs: number): string {
  const seconds = Math.round((Date.now() - timestampMs) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Duration as `1h 04m`, `22m 10s`, `45s`.
 *
 * Seconds are dropped when zero, so a whole number of minutes reads as `22m`
 * rather than the noisy `22m 00s`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${String(restMinutes).padStart(2, "0")}m`;
}

/**
 * Text progress bar.
 *
 * Only for ratios we can actually measure — a watch session has no known total
 * length, so it shows a duration instead of a misleading percentage.
 * `frac` is clamped to 0..1 because exceeding it would emit more blocks than
 * `width` and wrap the line.
 */
export function progressBar(frac: number, width = 10): string {
  if (!Number.isFinite(frac) || width <= 0) return "";
  const clamped = Math.max(0, Math.min(1, frac));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + color.dim("░".repeat(width - filled));
}

/** Full block box around body lines, with an optional title on the top edge. */
export function panel(
  lines: readonly string[],
  title?: string,
  width = 60,
): string[] {
  const inner = Math.max(20, width - 4);
  const out: string[] = [];

  if (title === undefined) {
    out.push(color.gray(`┌${"─".repeat(inner + 2)}┐`));
  } else {
    const label = ` ${truncate(title, inner - 2)} `;
    const rest = inner + 2 - label.length;
    out.push(color.gray(`┌${label}${color.dim("─".repeat(Math.max(0, rest)))}┐`));
  }

  for (const line of lines) {
    const body = truncate(line, inner);
    out.push(`${color.gray("│")} ${padTo(body, inner)} ${color.gray("│")}`);
  }
  out.push(color.gray(`└${"─".repeat(inner + 2)}┘`));
  return out;
}

/** Single status line describing the active session, shown under prompts. */
export function footer(parts: readonly string[]): string {
  const filled = parts.filter((part) => part !== "");
  return color.dim(`  ${filled.join(color.dim(" · "))}`);
}

export function formatDate(timestampMs: number): string {
  if (!timestampMs) return "-";
  const d = new Date(timestampMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Shorten a long path for display, keeping the tail which is the informative end. */
export function shortPath(fullPath: string, max = 60): string {
  if (fullPath.length <= max) return fullPath;
  return `…${fullPath.slice(fullPath.length - (max - 1))}`;
}

export function totalSize(files: readonly { size: number }[]): string {
  let total = 0;
  for (const file of files) total += file.size;
  return formatBytes(total);
}
