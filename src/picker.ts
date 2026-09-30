import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { listDriveRoots, listSubdirectories, type MediaFile } from "./scan.ts";
import { searchSelect, isSearchCancel, type SearchOption } from "./search-select.ts";
import { History } from "./history.ts";
import {
  MEDIA_MODES,
  MODE_HINTS,
  MODE_LABELS,
  modeExtensions,
  type MediaMode,
} from "./extensions.ts";
import { color, formatBytes, relativeTime, shortPath } from "./ui.ts";

type FolderAction =
  | { kind: "up" }
  | { kind: "drives" }
  | { kind: "enter"; name: string }
  | { kind: "scan" };

const CANCEL_SYMBOL = Symbol.for("rndvid.cancel");

/** Where the browser starts when there's no remembered folder. */
export async function defaultStartDir(): Promise<string> {
  const candidates = [
    path.join(os.homedir(), "Videos"),
    path.join(os.homedir(), "Desktop"),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return process.cwd();
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function isDriveRoot(dir: string): boolean {
  return path.parse(dir).root === dir;
}

/**
 * Media type menu, shown when no mode is fixed by --mode or remembered.
 *
 * Returns the chosen mode, or CANCEL.
 */
export async function chooseMediaMode(initial?: MediaMode): Promise<MediaMode | symbol> {
  const options: SearchOption<MediaMode>[] = MEDIA_MODES.map((mode) => ({
    value: mode,
    label: MODE_LABELS[mode],
    hint: MODE_HINTS[mode],
  }));

  const choice = await searchSelect<MediaMode>({
    message: "What are you picking?",
    options,
    maxVisible: MEDIA_MODES.length,
    initialValue: initial,
  });

  return isSearchCancel(choice) ? CANCEL_SYMBOL : choice;
}

/**
 * Drive picker, reachable from anywhere in the folder browser.
 *
 * Shows free space so an empty or near-full drive is obvious before committing
 * to a scan of it.
 */
export async function chooseDrive(): Promise<string | symbol> {
  const roots = await listDriveRoots();
  if (roots.length === 0) return CANCEL_SYMBOL;

  const options: SearchOption<string>[] = [];
  for (const root of roots) {
    options.push({
      value: root,
      label: root,
      hint: await describeDrive(root),
    });
  }

  const choice = await searchSelect<string>({
    message: "Drives",
    options,
    maxVisible: Math.min(8, roots.length),
    emptyMessage: "no drives found",
  });

  return isSearchCancel(choice) ? CANCEL_SYMBOL : (choice as string);
}

/** Free/used space for a drive root, or a note when it can't be read. */
async function describeDrive(root: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const raw = await new Promise<string>((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$v = Get-Volume -DriveLetter '${root[0]}' -ErrorAction Stop; ` +
            `"$([math]::Round($v.SizeRemaining/1GB,1)) GB free of $([math]::Round($v.Size/1GB,1)) GB"`,
        ],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    return raw.trim();
  } catch {
    return "drive";
  }
}

/**
 * Interactive folder browser. `..` walks up, directories descend, and
 * "Scan this folder" confirms the current one. Typing filters the list.
 *
 * "Change drive…" is offered at every level, not just at drive roots, so another
 * disk is reachable without first walking all the way back to C:\.
 */
export async function chooseFolder(
  startDir?: string,
  lastFolder?: string,
): Promise<string | symbol> {
  let current =
    startDir ??
    (lastFolder && (await isDirectory(lastFolder)) ? lastFolder : await defaultStartDir());

  while (true) {
    const subdirs = await listSubdirectories(current);
    const root = isDriveRoot(current);

    const options: SearchOption<FolderAction>[] = [];
    if (!root) {
      options.push({ value: { kind: "up" }, label: "..", hint: "parent folder" });
    }
    for (const name of subdirs) {
      options.push({ value: { kind: "enter", name }, label: name, hint: "folder" });
    }
    options.push({
      value: { kind: "scan" },
      label: "Scan this folder",
      hint: subdirs.length === 0 && !root ? "no subfolders" : "use this as the library",
    });
    options.push({ value: { kind: "drives" }, label: "Change drive…", hint: "pick another disk" });

    const choice = await searchSelect<FolderAction>({
      message: `Folder: ${shortPath(current, 64)}`,
      options,
      maxVisible: 12,
      emptyMessage: "no subfolders here — pick \"Scan this folder\"",
    });

    if (isSearchCancel(choice)) return choice;

    const action = choice as FolderAction;
    if (action.kind === "up") {
      current = path.dirname(current);
      continue;
    }
    if (action.kind === "scan") return current;
    if (action.kind === "enter") {
      current = path.join(current, action.name);
      continue;
    }
    if (action.kind === "drives") {
      const picked = await chooseDrive();
      if (typeof picked !== "string") return CANCEL_SYMBOL;
      current = picked;
      continue;
    }
  }
}

export type SortMode = "name" | "size" | "newest" | "oldest";

export function sortFiles(files: readonly MediaFile[], mode: SortMode): MediaFile[] {
  const copy = [...files];
  switch (mode) {
    case "size":
      copy.sort((a, b) => b.size - a.size);
      break;
    case "newest":
      copy.sort((a, b) => b.mtimeMs - a.mtimeMs);
      break;
    case "oldest":
      copy.sort((a, b) => a.mtimeMs - b.mtimeMs);
      break;
    case "name":
    default:
      copy.sort((a, b) => a.rel.localeCompare(b.rel));
      break;
  }
  return copy;
}

export const SORT_MODES: readonly SortMode[] = ["name", "size", "newest", "oldest"];

/**
 * Browse the whole library. Picking a row returns that file so it can be played
 * directly instead of rolled. Cancelling returns to the caller, which turns it
 * into a prompt rather than an exit.
 */
export async function libraryView(
  files: readonly MediaFile[],
  history: History,
  mode: SortMode,
  mediaMode: MediaMode,
): Promise<MediaFile | symbol> {
  const sorted = sortFiles(files, mode);
  const noun = mediaMode === "book" ? "books" : mediaMode === "audio" ? "audio files" : "videos";

  const options: SearchOption<MediaFile>[] = sorted.map((file) => {
    const watched = history.has(file);
    const seen = watched ? history.lastPlayed(file) : null;
    const seenText = seen ? `watched ${relativeTime(seen)}` : "";
    return {
      value: file,
      label: file.rel,
      hint: [
        formatBytes(file.size),
        seenText,
        file.mtimeMs ? `added ${new Date(file.mtimeMs).toISOString().slice(0, 10)}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });

  const choice = await searchSelect<MediaFile>({
    message: `Library (${files.length} ${noun}, sorted by ${mode})`,
    options,
    maxVisible: 15,
    emptyMessage: "nothing matches that search",
  });

  return isSearchCancel(choice) ? CANCEL_SYMBOL : (choice as MediaFile);
}

/** One-line summary of the active mode, for prompts and the browser header. */
export function modeSummary(mediaMode: MediaMode): string {
  return `${MODE_LABELS[mediaMode]} (${modeExtensions(mediaMode)})`;
}

/** Prompt shown when a scan finds nothing, explaining what it looked for. */
export function noMatchesMessage(mediaMode: MediaMode, dirsVisited: number): string {
  return [
    `Checked ${dirsVisited} folders for ${MODE_LABELS[mediaMode].toLowerCase()} files.`,
    `Supported: ${modeExtensions(mediaMode)}`,
  ].join("\n");
}

/** Short description of the roll, e.g. "3 video". */
export function rollNoun(count: number, mediaMode: MediaMode): string {
  if (mediaMode === "book") return `${count} book${count === 1 ? "" : "s"}`;
  if (mediaMode === "audio") return `${count} file${count === 1 ? "" : "s"}`;
  return `${count} video${count === 1 ? "" : "s"}`;
}

/** Verb used when launching, since opening a book isn't quite "playing". */
export function openVerb(mediaMode: MediaMode): string {
  return mediaMode === "book" ? "open" : "play";
}

/** Plural noun for the active mode, used in count summaries. */
export function libraryNoun(mediaMode: MediaMode): string {
  return mediaMode === "book" ? "book" : mediaMode === "audio" ? "audio file" : "video";
}

export { color, CANCEL_SYMBOL };
