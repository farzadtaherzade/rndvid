import path from "node:path";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";

import { modeExtension, modeExtensions, type MediaMode } from "./extensions.ts";

export interface MediaFile {
  /** Absolute path on disk. */
  path: string;
  name: string;
  ext: string;
  /** Path relative to the scan root, always with `/` separators. */
  rel: string;
  size: number;
  mtimeMs: number;
}

export type ScanResult = {
  root: string;
  mode: MediaMode;
  files: MediaFile[];
  /** Folders visited, including ones that held no matching file. */
  dirsVisited: number;
  /** Non-fatal problems, surfaced in the UI. */
  errors: string[];
  /** True when the depth cap stopped the walk early. */
  truncated: boolean;
  /** Deepest folder reached before the cap hit, relative to the root. */
  deepestHit: string | null;
  /** Effective depth cap, or 0 when unbounded. */
  maxDepth: number;
};

/** Folders that never hold a personal media library, by name. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "$recycle.bin",
  "system volume information",
  "$windows.~bt",
  "$windows.~ws",
  "windows",
  "winsxs",
  "driverstore",
  "perflogs",
  "inetpub",
  "program files",
  "program files (x86)",
  "program files (amd64)",
  "programdata",
  "appdata",
  "recovery",
  // Book and media library noise.
  "__macosx",
  "thumbs.db",
]);

function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_DIRS.has(lower)) return true;
  // Skip hidden folders like .cache, but keep anything starting with a normal char.
  return lower.startsWith(".");
}

export const DEFAULT_MAX_DEPTH = 4;

export interface ScanOptions {
  mode: MediaMode;
  /** Folders to descend into, counted from the root. 0 means unbounded. */
  maxDepth?: number;
  /** Hard cap on file count so a pathological tree can't eat memory. */
  maxFiles?: number;
}

/**
 * Depth-first recursive walk collecting files that match `mode`.
 *
 * Symlinks are recorded by realpath, so a circular link or a folder reachable by
 * two paths can't make this walk forever.
 */
export async function scanMedia(
  root: string,
  options: ScanOptions,
): Promise<ScanResult> {
  const { mode } = options;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? 200_000;

  const files: MediaFile[] = [];
  const errors: string[] = [];
  const seenDirs = new Set<string>();
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  let dirsVisited = 0;
  let truncated = false;
  let deepestHit: string | null = null;

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    dirsVisited += 1;

    let key: string;
    try {
      key = (await fs.realpath(dir)).toLowerCase();
    } catch {
      key = path.resolve(dir).toLowerCase();
    }
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`${dir}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`);
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        // maxDepth 0 means unbounded; otherwise don't descend past the cap.
        if (maxDepth > 0 && depth >= maxDepth) {
          truncated = true;
          const rel = toPosixRelative(root, full);
          if (deepestHit === null || rel.length > deepestHit.length) deepestHit = rel;
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }

      const ext = modeExtension(entry.name, mode);
      if (ext === null) continue;
      if (!(await isRegularFile(full, entry))) continue;

      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await fs.stat(full);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // Unreadable stat: keep the file with zeroed metadata rather than dropping it.
      }

      files.push({
        path: full,
        name: entry.name,
        ext,
        rel: toPosixRelative(root, full),
        size,
        mtimeMs,
      });

      if (files.length >= maxFiles) {
        errors.push(`Stopped at ${maxFiles} files (max reached).`);
        return { root, mode, files, dirsVisited, errors, truncated, deepestHit, maxDepth };
      }
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return { root, mode, files, dirsVisited, errors, truncated, deepestHit, maxDepth };
}

/** Convenience wrapper for the common video case. */
export async function scanVideos(
  root: string,
  options: { maxDepth?: number } = {},
): Promise<ScanResult> {
  return scanMedia(root, { mode: "video", ...options });
}

async function isRegularFile(full: string, entry: Dirent): Promise<boolean> {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    const target = await fs.stat(full);
    return target.isFile();
  } catch {
    return false;
  }
}

function toPosixRelative(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join("/");
}

/** Subdirectory names for the folder browser, hidden and system folders removed. */
export async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !shouldSkipDir(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Windows drives available to the user, as `C:\`-style roots. */
export async function listDriveRoots(): Promise<string[]> {
  if (process.platform !== "win32") return [path.parse(process.cwd()).root];
  const roots: string[] = [];
  for (let code = 0x41; code <= 0x5a; code += 1) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      await fs.stat(root);
      roots.push(root);
    } catch {
      // Drive not present or not ready; skip it.
    }
  }
  return roots;
}

export { modeExtensions };
