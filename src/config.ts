import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { isMediaMode, type MediaMode } from "./extensions.ts";

const APP_NAME = "rndvid";

/**
 * Where settings and history live.
 *
 * %APPDATA%\rndvid on Windows, ~/.local/share/rndvid elsewhere. `RNDVID_DATA_DIR`
 * overrides it so tests can use a sandbox instead of the real profile.
 */
export function dataDir(): string {
  const override = process.env["RNDVID_DATA_DIR"];
  if (override) return override;

  const base =
    process.env["APPDATA"] && process.platform === "win32"
      ? process.env["APPDATA"]
      : path.join(os.homedir(), ".local", "share");
  return path.join(base, APP_NAME);
}

export function historyDir(): string {
  return path.join(dataDir(), "history");
}

export function settingsFile(): string {
  return path.join(dataDir(), "settings.json");
}

export interface Settings {
  /** Last folder the user confirmed a scan on. */
  lastFolder?: string;
  /** Media mode used last. The picker opens straight to a folder when set. */
  mode?: MediaMode;
  /** Whether "play, wait for exit" is the default, or fire-and-forget. */
  waitForPlayer?: boolean;
}

const SETTINGS_DEFAULTS: Settings = { waitForPlayer: true };

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsFile(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...SETTINGS_DEFAULTS };
    const obj = parsed as Record<string, unknown>;
    const out: Settings = { ...SETTINGS_DEFAULTS };
    if (typeof obj["lastFolder"] === "string") out.lastFolder = obj["lastFolder"];
    if (isMediaMode(obj["mode"])) out.mode = obj["mode"];
    if (typeof obj["waitForPlayer"] === "boolean") out.waitForPlayer = obj["waitForPlayer"];
    return out;
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = `${settingsFile()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
  await fs.rename(tmp, settingsFile());
}

/**
 * Stable per-folder key so each library keeps its own history file.
 * Normalises the path first so casing and trailing slashes don't fork a history.
 */
export function folderKey(folder: string): string {
  const normalised = path.resolve(folder).replace(/[\\/]+$/, "").toLowerCase();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}
