/**
 * Keyboard shortcuts and the help panel.
 *
 * Kept as data so the help text and the actual bindings can't drift apart — the
 * panel renders whatever this table says.
 */

export type Action =
  | "roll1"
  | "roll3"
  | "roll5"
  | "rollAll"
  | "tree"
  | "recentFiles"
  | "recentFolders"
  | "filter"
  | "undo"
  | "toggleWatched"
  | "library"
  | "changeFolder"
  | "help"
  | "quit";

export interface Shortcut {
  keys: string;
  action: Action;
  label: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: "1", action: "roll1", label: "roll 1" },
  { keys: "3", action: "roll3", label: "roll 3" },
  { keys: "5", action: "roll5", label: "roll 5" },
  { keys: "a", action: "rollAll", label: "roll everything" },
  { keys: "t", action: "tree", label: "folder tree" },
  { keys: "r", action: "recentFiles", label: "recently opened" },
  { keys: "R", action: "recentFolders", label: "recent folders" },
  { keys: "f", action: "filter", label: "size filter" },
  { keys: "u", action: "undo", label: "undo last pick" },
  { keys: "w", action: "toggleWatched", label: "skip watched on/off" },
  { keys: "l", action: "library", label: "library view" },
  { keys: "d", action: "changeFolder", label: "change folder" },
  { keys: "?", action: "help", label: "this panel" },
  { keys: "q", action: "quit", label: "quit" },
];

const BY_KEY = new Map<string, Action>(
  SHORTCUTS.flatMap((shortcut) => [
    [shortcut.keys, shortcut.action] as const,
    // Digits and letters also accept their uppercase form, so Caps Lock or a
    // held Shift doesn't silently do nothing.
    [shortcut.keys.toUpperCase(), shortcut.action] as const,
  ]),
);

/** Map a keystroke to an action, or null when it isn't a shortcut. */
export function shortcutFor(key: string): Action | null {
  return BY_KEY.get(key) ?? null;
}

/** The help panel body, rendered by the caller's box drawer. */
export function helpLines(): string[] {
  const width = Math.max(...SHORTCUTS.map((s) => s.keys.length));
  return SHORTCUTS.map((s) => `  ${s.keys.padEnd(width)}   ${s.label}`);
}

/** One-line reminder for the footer, since a full panel every run is noise. */
export const HELP_HINT = "press ? for shortcuts";
