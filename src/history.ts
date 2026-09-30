import path from "node:path";
import fs from "node:fs/promises";

import { folderKey, historyDir } from "./config.ts";
import type { MediaFile } from "./scan.ts";

interface HistoryFile {
  version: 1;
  /** Absolute root this history belongs to, for the "stale library" warning. */
  folder: string;
  /** Keyed by scan-relative posix path. */
  entries: Record<string, { lastPlayed: number; plays: number }>;
}

/**
 * Fresh data per instance. Not a shared module constant: `entries` must not be
 * aliased between History objects, or one folder's marks leak into another's.
 */
function emptyData(folder: string): HistoryFile {
  return { version: 1, folder, entries: {} };
}

/**
 * Per-folder watch history.
 *
 * Keyed by path relative to the folder rather than absolute, so moving or
 * renaming files inside the library doesn't lose their history. One JSON file
 * per library under %APPDATA%, so a bad write can only ever affect one folder.
 */
export class History {
  private constructor(
    private readonly file: string,
    private readonly folder: string,
    private readonly data: HistoryFile,
  ) {}

  static async load(folder: string): Promise<History> {
    const file = path.join(historyDir(), `${folderKey(folder)}.json`);
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return new History(file, folder, emptyData(folder));
      }
      const obj = parsed as Record<string, unknown>;
      const entries: HistoryFile["entries"] = {};
      if (typeof obj["entries"] === "object" && obj["entries"] !== null) {
        for (const [key, value] of Object.entries(obj["entries"] as Record<string, unknown>)) {
          if (typeof value !== "object" || value === null) continue;
          const entry = value as Record<string, unknown>;
          const lastPlayed = typeof entry["lastPlayed"] === "number" ? entry["lastPlayed"] : 0;
          const plays = typeof entry["plays"] === "number" ? entry["plays"] : 1;
          entries[key] = { lastPlayed, plays };
        }
      }
      const root = typeof obj["folder"] === "string" ? obj["folder"] : folder;
      return new History(file, folder, { version: 1, folder: root, entries });
    } catch {
      // Missing or corrupt history is not an error; start clean.
      return new History(file, folder, emptyData(folder));
    }
  }

  /** True if the history file was written for a different path than this folder. */
  get stale(): boolean {
    if (!this.data.folder) return false;
    return path.resolve(this.data.folder).toLowerCase() !== path.resolve(this.folder).toLowerCase();
  }

  has(file: MediaFile): boolean {
    return this.data.entries[file.rel] !== undefined;
  }

  get count(): number {
    return Object.keys(this.data.entries).length;
  }

  lastPlayed(file: MediaFile): number | null {
    return this.data.entries[file.rel]?.lastPlayed ?? null;
  }

  /** Record a launch. Called on launch, not on completion, so a file is only re-rolled after you actually opened it. */
  markWatched(file: MediaFile): void {
    const existing = this.data.entries[file.rel];
    this.data.entries[file.rel] = {
      lastPlayed: Date.now(),
      plays: (existing?.plays ?? 0) + 1,
    };
  }

  /** Drop entries for files no longer present in the library. */
  prune(liveFiles: readonly MediaFile[]): number {
    const live = new Set(liveFiles.map((f) => f.rel));
    let removed = 0;
    for (const key of Object.keys(this.data.entries)) {
      if (!live.has(key)) {
        delete this.data.entries[key];
        removed += 1;
      }
    }
    return removed;
  }

  async save(): Promise<void> {
    await fs.mkdir(historyDir(), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }
}

