/**
 * Media modes.
 *
 * Each mode owns its extension list, and the scanner only collects files whose
 * extension belongs to the active mode. That's what keeps a book scan from
 * dragging in every video on the drive, and vice versa.
 */

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mkv",
  "avi",
  "mov",
  "webm",
  "m4v",
  "ts",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
  "ogv",
] as const;

export const BOOK_EXTENSIONS = [
  "epub",
  "pdf",
  "mobi",
  "azw",
  "azw3",
  "fb2",
  "djvu",
  "cbz",
  "cbr",
  // Audiobooks live with the ebooks since they're picked from the same shelf.
  "m4b",
  "m4a",
  "aac",
] as const;

export const AUDIO_EXTENSIONS = [
  "mp3",
  "m4a",
  "aac",
  "flac",
  "wav",
  "ogg",
  "opus",
  "wma",
  "aiff",
  "m4b",
] as const;

export type MediaMode = "video" | "book" | "audio";

export const MEDIA_MODES: readonly MediaMode[] = ["video", "book", "audio"];

export const MODE_LABELS: Record<MediaMode, string> = {
  video: "Video",
  book: "Book",
  audio: "Audio",
};

/** One-line summary shown under each mode in the menu. */
export const MODE_HINTS: Record<MediaMode, string> = {
  video: "mp4 mkv avi mov webm ts …",
  book: "epub pdf mobi azw3 cbz m4b …",
  audio: "mp3 flac m4a wav opus …",
};

const EXTENSIONS: Record<MediaMode, ReadonlySet<string>> = {
  video: new Set(VIDEO_EXTENSIONS),
  book: new Set(BOOK_EXTENSIONS),
  audio: new Set(AUDIO_EXTENSIONS),
};

export function isMediaMode(value: unknown): value is MediaMode {
  return typeof value === "string" && (MEDIA_MODES as readonly string[]).includes(value);
}

/** Human-readable extension list for a mode, for prompts and errors. */
export function modeExtensions(mode: MediaMode): string {
  const list = EXTENSIONS[mode];
  const sorted = [...list].sort();
  // Cap the display so the menu hint stays one line.
  return sorted.slice(0, 8).join(" ") + (sorted.length > 8 ? " …" : "");
}

/**
 * Case-insensitive extension test. Returns the lowercase extension without the
 * dot, or null when the file isn't in this mode's set.
 */
export function modeExtension(fileName: string, mode: MediaMode): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return EXTENSIONS[mode].has(ext) ? ext : null;
}

/** True when the file would be picked in any mode. */
export function isAnyMedia(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return false;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return MEDIA_MODES.some((mode) => EXTENSIONS[mode].has(ext));
}

/** Back-compat helper for callers that only care about video. */
export function videoExtension(fileName: string): string | null {
  return modeExtension(fileName, "video");
}
