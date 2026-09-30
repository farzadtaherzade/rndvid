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
