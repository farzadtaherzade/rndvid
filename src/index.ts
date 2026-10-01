#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs/promises";

import { scanMedia, DEFAULT_MAX_DEPTH, type MediaFile } from "./scan.ts";
import { loadSettings, saveSettings, withRecentFolder, type Settings } from "./config.ts";
import { History, type HistoryEntry } from "./history.ts";
import { parseSizeRange, filterBySize, describeLibrary, type SizeRange } from "./filters.ts";
import { pickMany } from "./random.ts";
import { openInDefaultPlayer } from "./player.ts";
import {
  askResume,
  chooseFolder,
  chooseMediaMode,
  chooseRecentFile,
  chooseRecentFolder,
  libraryNoun,
  libraryView,
  noMatchesMessage,
  openVerb,
  rollNoun,
  sortFiles,
  SORT_MODES,
  type SortMode,
} from "./picker.ts";
import { searchSelect, isSearchCancel } from "./search-select.ts";
import { treePrompt, filesUnder } from "./tree.ts";
import { loadRecentFiles, recordRecentFile, type RecentFile } from "./recent.ts";
import { shortcutFor, helpLines, HELP_HINT } from "./shortcuts.ts";
import { readOneKey, isOneKeyCancel } from "./keypress.ts";
import { MEDIA_MODES, MODE_HINTS, MODE_LABELS, isMediaMode, type MediaMode } from "./extensions.ts";
import {
  color,
  confirm,
  footer,
  formatBytes,
  formatDuration,
  intro,
  isCancel,
  log,
  outro,
  panel,
  shortPath,
  spinner,
  text,
} from "./ui.ts";

interface Args {
  folder?: string;
  size?: string;
  count?: number;
  mode?: MediaMode;
  maxDepth: number;
  detach: boolean;
  excludeWatched: boolean;
  library: boolean;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    detach: false,
    excludeWatched: false,
    library: false,
    dryRun: false,
    help: false,
    maxDepth: DEFAULT_MAX_DEPTH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      // A negative number is a legitimate value for numeric options
      // (--max-depth -1), so only treat the token as a flag when it isn't a
      // bare number. Rejecting any leading "-" would mask the real error
      // message with "needs a value".
      const isFlag =
        value !== undefined && value.startsWith("-") && !/^-\d/.test(value);
      if (value === undefined || isFlag) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case "-f":
      case "--folder":
        args.folder = next();
        break;
      case "--size":
        args.size = next();
        break;
      case "-n":
      case "--count": {
        const raw = next();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`--count must be a positive integer, got "${raw}"`);
        }
        args.count = parsed;
        break;
      }
      case "--mode": {
        const raw = next();
        if (!isMediaMode(raw)) {
          throw new Error(`--mode must be one of: ${MEDIA_MODES.join(", ")}, got "${raw}"`);
        }
        args.mode = raw;
        break;
      }
      case "--max-depth": {
        const raw = next();
        const parsed = Number.parseInt(raw, 10);
        // 0 means unbounded, which is why negatives are rejected here.
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`--max-depth must be 0 or a positive integer, got "${raw}"`);
        }
        args.maxDepth = parsed;
        break;
      }
      case "--detach":
        args.detach = true;
        break;
      case "--exclude-watched":
        args.excludeWatched = true;
        break;
      case "--library":
        args.library = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

const HELP = `
${color.bold("rndvid")} — pick a random video, book or audio file from a folder and open it

  ${color.gray("bun run src/index.ts")} [options]

  -f, --folder <path>     library folder (skips the browser)
  -n, --count <n>         number of files to roll (default 1)
      --mode <name>       ${MEDIA_MODES.join(" | ")} (skips the media menu)
      --max-depth <n>     folders to descend (default ${DEFAULT_MAX_DEPTH}, 0 = unlimited)
      --size <range>      size filter, e.g. 500mb, >1gb, 200mb-2gb
      --exclude-watched   skip files you've already played
      --detach            don't wait for the app to close
      --library           open the library browser instead of rolling
      --dry-run           print the picks without asking or playing
  -h, --help              show this

  ${color.bold("Media")}   video  ${MODE_HINTS.video}
           book   ${MODE_HINTS.book}
           audio  ${MODE_HINTS.audio}

  With no --folder you get a searchable folder browser. Type to filter,
  ${color.gray("↑↓")} to move, ${color.gray("enter")} to open a folder or confirm the scan,
  ${color.gray("esc")} to clear the search (then cancel). ${color.gray("Change drive…")} reaches
  any disk from anywhere in the browser.
`;

async function resolveFolder(args: Args, settings: Settings): Promise<string | symbol> {
  if (args.folder) {
    const resolved = path.resolve(args.folder);
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) {
        log.error(`Not a folder: ${resolved}`);
        return Symbol.for("rndvid.cancel");
      }
    } catch {
      log.error(`Folder not found: ${resolved}`);
      return Symbol.for("rndvid.cancel");
    }
    return resolved;
  }

  // Offer the remembered library instead of dropping straight into the browser,
  // but only when the user last said yes to being asked.
  const remembered = settings.lastFolder;
  const resumeWorthAsking =
    remembered !== undefined && settings.resumeLastFolder !== false && !args.dryRun;

  if (resumeWorthAsking && remembered) {
    let exists = false;
    try {
      exists = (await fs.stat(remembered)).isDirectory();
    } catch {
      exists = false;
    }

    if (exists) {
      const choice = await askResume(remembered, "", settings.resumeLastFolder !== false);
      if (choice === null) return Symbol.for("rndvid.cancel");
      if (choice === remembered) {
        // Remember the preference so next time either asks or doesn't.
        if (settings.resumeLastFolder !== true) {
          settings = { ...settings, resumeLastFolder: true };
          await saveSettings(settings).catch(() => {});
        }
        return remembered;
      }
      settings = { ...settings, resumeLastFolder: false };
      await saveSettings(settings).catch(() => {});
    }
  }

  return chooseFolder(undefined, remembered);
}

/**
 * Walk the tree, showing a spinner while it runs.
 *
 * Only start/stop are used: `spinner.message()` reaches a private resolver that
 * throws under Bun, and restarting the spinner per update flickers badly on a
 * fast SSD. Progress counts are reported in the completion line instead.
 */
async function runScan(root: string, mediaMode: MediaMode, maxDepth: number) {
  const spin = spinner();
  spin.start(`scanning for ${MODE_LABELS[mediaMode].toLowerCase()}…`);

  const result = await scanMedia(root, { mode: mediaMode, maxDepth });

  spin.stop(
    `scanned ${rollNoun(result.files.length, mediaMode)} ` +
      `in ${result.dirsVisited} folder${result.dirsVisited === 1 ? "" : "s"}` +
      (result.maxDepth > 0 ? ` (depth ≤ ${result.maxDepth})` : ""),
  );
  return result;
}

async function promptSizeRange(initial: string): Promise<SizeRange | symbol> {
  const answer = await text({
    message: "Size filter (blank = any)",
    placeholder: "e.g. 500mb-2gb, >1gb, <800mb",
    initialValue: initial,
    validate: (value) => {
      if (value.trim() === "") return undefined;
      const parsed = parseSizeRange(value);
      return parsed.error;
    },
  });
  if (isCancel(answer)) return answer;
  return parseSizeRange(String(answer)).range ?? {};
}

async function promptCount(initial: number): Promise<number | symbol> {
  const answer = await text({
    message: "How many videos?",
    placeholder: "1",
    initialValue: String(initial),
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed === "") return undefined;
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(parsed) || parsed < 1) return "enter a whole number of 1 or more";
      return undefined;
    },
  });
  if (isCancel(answer)) return answer;
  const parsed = Number.parseInt(String(answer).trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : initial;
}

function describeFile(file: MediaFile): string {
  return `${color.bold(file.name)}\n${color.dim(file.rel)}`;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${color.red(String((err as Error).message))}\n`);
    process.stderr.write("Run with --help for usage.\n");
    return 2;
  }

  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  let settings = await loadSettings();
  intro(`${color.bgCyan(color.black(" rndvid "))}  random media picker`);

  // Mode resolution: --mode wins, then a remembered choice, then the menu. A
  // headless run with neither falls back to video rather than trying to prompt,
  // since a prompt with no terminal just cancels the whole run.
  let mediaMode: MediaMode;
  if (args.mode) {
    mediaMode = args.mode;
  } else if (settings.mode) {
    mediaMode = settings.mode;
    log.info(color.dim(`Mode: ${MODE_LABELS[mediaMode]}`));
  } else if (args.dryRun || !process.stdin.isTTY) {
    mediaMode = "video";
  } else {
    const picked = await chooseMediaMode();
    if (typeof picked !== "string") {
      outro(color.dim("cancelled"));
      return 0;
    }
    mediaMode = picked;
    settings = { ...settings, mode: mediaMode };
    await saveSettings(settings).catch(() => {});
  }

  const startFolder = await resolveFolder(args, settings);
  if (typeof startFolder !== "string") {
    outro(color.dim("cancelled"));
    return 0;
  }
  let root: string = startFolder;

  // Remember the library for next time, so the browser reopens where you left off.
  settings = {
    ...settings,
    lastFolder: root,
    mode: mediaMode,
    recentFolders: withRecentFolder(settings.recentFolders ?? [], root, settings.recentLimit),
  };
  await saveSettings(settings).catch(() => {
    /* a read-only APPDATA shouldn't stop the run */
  });

  let watchMode = settings.waitForPlayer !== false && !args.detach;
  let sortMode: SortMode = "name";
  /** Most recent launch, so `u` can put it back. */
  let lastPick: { file: MediaFile; token: HistoryEntry | null; history: History } | null = null;

  outer: for (;;) {
    const scan = await runScan(root, mediaMode, args.maxDepth);

    if (scan.errors.length > 0) {
      log.warn(`${scan.errors.length} folder(s) skipped — first: ${scan.errors[0]}`);
    }

    // Say so rather than silently missing files below the cap.
    if (scan.truncated) {
      log.warn(
        `Depth cap of ${scan.maxDepth} reached — deeper folders weren't searched` +
          (scan.deepestHit ? ` (e.g. ${scan.deepestHit})` : "") +
          `. Use ${color.cyan("--max-depth 0")} for everything.`,
      );
    }

    if (scan.files.length === 0) {
      log.error(`No ${MODE_LABELS[mediaMode].toLowerCase()} files under ${root}`);
      for (const line of noMatchesMessage(mediaMode, scan.dirsVisited).split("\n")) {
        log.message(`  ${color.dim(line)}`);
      }
      if (args.dryRun) break; // never prompt in headless mode
      const again = await confirm({ message: "Choose a different folder?" });
      if (isCancel(again) || !again) break;
      const picked = await chooseFolder(undefined, root);
      if (typeof picked !== "string") break;
      settings = { ...settings, lastFolder: picked };
      await saveSettings(settings).catch(() => {});
      root = picked;
      continue outer;
    }

    const history = await History.load(root);

    log.info(
      color.bold(describeLibrary(scan.files, libraryNoun(mediaMode))) +
        (history.count > 0 ? color.dim(` · ${history.count} watched before`) : ""),
    );

    // Keep the recent list honest: folders that disappeared shouldn't accumulate
    // into a startup menu full of paths that can't be opened.
    const recents = settings.recentFolders ?? [];
    if (recents.length > 0) {
      const alive: string[] = [];
      for (const folder of recents) {
        try {
          if ((await fs.stat(folder)).isDirectory()) alive.push(folder);
        } catch {
          // Gone; drop it.
        }
      }
      if (alive.length !== recents.length) {
        settings = { ...settings, recentFolders: alive };
        await saveSettings(settings).catch(() => {});
      }
    }

    if (history.stale) {
      log.warn("History was written for a different path; treating as fresh.");
    }

    // ---- filters ----
    let sizeRange: SizeRange = {};
    if (args.size !== undefined) {
      const parsed = parseSizeRange(args.size);
      if (parsed.error) {
        log.error(`--size: ${parsed.error}`);
        return 1;
      }
      sizeRange = parsed.range ?? {};
    } else if (args.dryRun) {
      sizeRange = {};
    } else {
      const asked = await promptSizeRange("");
      if (typeof asked === "symbol") break;
      sizeRange = asked;
    }

    let excludeWatched = args.excludeWatched;
    if (!args.excludeWatched && history.count > 0 && !args.dryRun) {
      const asked = await confirm({
        message: `Skip the ${history.count} you've already watched?`,
        initialValue: false,
      });
      if (isCancel(asked)) break;
      excludeWatched = asked;
    }

    let pool = filterBySize(scan.files, sizeRange);
    const filtered = pool.length !== scan.files.length;
    if (filtered) log.info(`${pool.length} left after size filter`);

    if (excludeWatched) {
      const unseen = pool.filter((f) => !history.has(f));
      if (unseen.length === 0) {
        if (args.dryRun) {
          log.warn("Everything here is watched already.");
          break;
        }
        log.warn("Everything here is watched already.");
        const retry = await confirm({ message: "Include watched files again?" });
        if (isCancel(retry) || !retry) break;
      } else if (unseen.length !== pool.length) {
        log.info(`${unseen.length} unwatched of ${pool.length}`);
        pool = unseen;
      }
    }

    if (pool.length === 0) {
      log.error("Size filter left nothing. Try a wider range.");
      if (args.dryRun) break; // re-asking would loop forever headless
      continue outer;
    }

    // ---- library browser ----
    if (args.library) {
      if (args.dryRun) {
        // Print the listing the browser would show, so it's scriptable.
        const noun = mediaMode === "book" ? "books" : mediaMode === "audio" ? "audio files" : "videos";
        log.message(`Library (${pool.length} ${noun}, sorted by ${sortMode})`);
        for (const file of sortFiles(pool, sortMode)) {
          log.message(`  ${file.rel}  ${color.dim(formatBytes(file.size))}`);
        }
        break;
      }

      const chosen = await libraryView(pool, history, sortMode, mediaMode);
      if (isSearchCancel(chosen)) {
        const sortIt = await confirm({ message: "Change sort order?", initialValue: false });
        if (isCancel(sortIt) || !sortIt) break;
        const next = await searchSort();
        if (typeof next !== "symbol") sortMode = next;
        continue outer;
      }

      const file = chosen as MediaFile;
      history.markWatched(file);
      await history.save().catch(() => {});
      const result = await openInDefaultPlayer(file.path, { wait: watchMode });
      if (!result.ok) log.error(`Could not open ${file.name}: ${result.error ?? "unknown error"}`);
      if (watchMode && !result.waited) await waitForReturn();
      continue outer;
    }

    // ---- roll ----
    let count = args.count ?? 1;
    if (!args.dryRun) {
      const asked = await promptCount(count);
      if (typeof asked === "symbol") break;
      count = asked;
    }
    if (count > pool.length) {
      log.warn(`Only ${pool.length} available; rolling all of them.`);
      count = pool.length;
    }

    const picks = pickMany(pool, count);
    log.step(`Rolled ${rollNoun(picks.length, mediaMode)}:`);

    // One line per pick rather than clack's `note`, which pads to a fixed box
    // width and mangles entries containing ANSI codes. The size sits inline at
    // the end so a large roll stays scannable.
    const labelWidth = Math.min(
      46,
      Math.max(20, ...picks.map((f) => f.rel.length)),
    );
    for (const [i, file] of picks.entries()) {
      const position = color.cyan(String(i + 1).padStart(2));
      const label = file.rel.length > labelWidth
        ? `…${file.rel.slice(file.rel.length - (labelWidth - 1))}`
        : file.rel.padEnd(labelWidth, " ");
      log.message(`  ${position}  ${label}  ${color.dim(formatBytes(file.size))}`);
    }

    // Status line: what's in play right now. Cheap to compute and it removes the
    // need to scroll back for the mode, folder and pool size.
    log.message(
      footer([
        MODE_LABELS[mediaMode],
        shortPath(root, 40),
        `${pool.length} in pool`,
        excludeWatched ? "skipping watched" : "",
        HELP_HINT,
      ]),
    );

    // --dry-run stops here: everything above is real, nothing is asked or played.
    if (args.dryRun) break;

    if (args.detach !== true && settings.waitForPlayer !== false) {
      const askedMode = await confirm({
        message: `Wait for it to close before ${openVerb(mediaMode)}ing the next one?`,
        initialValue: watchMode,
      });
      if (isCancel(askedMode)) break;
      watchMode = askedMode;
      settings = { ...settings, waitForPlayer: watchMode };
      await saveSettings(settings).catch(() => {});
    } else if (args.detach) {
      watchMode = false;
    }

    for (let i = 0; i < picks.length; i += 1) {
      const file = picks[i]!;
      log.message(`\n${color.gray(`[${i + 1}/${picks.length}]`)} ${describeFile(file)}`);

      // Record before launching so a player that crashes still counts as watched,
      // and keep the token so `u` can undo exactly this mark.
      const token = history.markWatched(file);
      lastPick = { file, token, history };
      await history.save().catch(() => {});
      await recordRecentFile({
        folder: root,
        rel: file.rel,
        name: file.name,
        openedAt: Date.now(),
      }).catch(() => {});

      const startedAt = Date.now();
      const result = await openInDefaultPlayer(file.path, { wait: watchMode });
      if (!result.ok) {
        log.error(`Could not open ${file.name}: ${result.error ?? "unknown error"}`);
      } else if (!result.waited) {
        // Fallback path via `start`: we can't see when the player exits, so the
        // session length has to come from the user dismissing the prompt.
        await waitForReturn();
      }

      // Wall-clock time with the file open. A proxy for how far in you got, not a
      // real position — nothing asks the player where it is.
      const sessionMs = Date.now() - startedAt;
      if (sessionMs > 30_000) {
        history.recordSession(file, sessionMs);
        await history.save().catch(() => {});
        log.message(color.dim(`  watched ${formatDuration(sessionMs)}`));
      }
    }

    // Shortcut bar. Single keystrokes, so Enter means "the default" (roll again).
    const next = await actionBar();
    if (next === "quit" || next === null) break;

    if (next === "undo") {
      if (!lastPick) {
        log.warn("Nothing to undo.");
        continue;
      }
      const undone = lastPick.history.undo(lastPick.file, lastPick.token);
      await lastPick.history.save().catch(() => {});
      if (undone) {
        log.info(`Put back: ${lastPick.file.rel}`);
        lastPick = null;
      }
      continue;
    }

    if (next === "toggleWatched") {
      excludeWatched = !excludeWatched;
      log.info(`Skip watched: ${excludeWatched ? "on" : "off"}`);
      continue outer;
    }

    if (next === "tree") {
      const result = await treePrompt({
        root,
        files: pool,
        history,
        title: `${MODE_LABELS[mediaMode]} library`,
      });
      if (result.action === "roll") {
        if (result.folder !== root) {
          root = result.folder;
          settings = {
            ...settings,
            lastFolder: root,
            recentFolders: withRecentFolder(settings.recentFolders ?? [], root, settings.recentLimit),
          };
          await saveSettings(settings).catch(() => {});
        }
        count = filesUnder(result.node).length || 1;
        continue outer;
      }
      if (result.action === "browse") {
        const picked = await chooseFolder(undefined, root);
        if (typeof picked !== "string") break;
        root = picked;
        settings = { ...settings, lastFolder: picked };
        await saveSettings(settings).catch(() => {});
        continue outer;
      }
      continue;
    }

    if (next === "recentFolders") {
      const picked = await chooseRecentFolder(settings.recentFolders ?? []);
      if (picked === CANCEL_RECENT) continue;
      const target = picked === "" ? await chooseFolder(undefined, root) : picked;
      if (typeof target !== "string") continue;
      root = target;
      settings = { ...settings, lastFolder: target };
      await saveSettings(settings).catch(() => {});
      continue outer;
    }

    if (next === "recentFiles") {
      const entries = (await loadRecentFiles()).slice(0, 20);
      const chosen = await chooseRecentFile(entries);
      if (typeof chosen !== "object" || chosen === null) continue;
      const file = await resolveRecent(chosen);
      if (!file) {
        log.warn(`No longer there: ${chosen.name}`);
        continue;
      }
      await openDirect(file, chosen.folder, watchMode);
      continue;
    }

    if (next === "library") {
      const chosen = await libraryView(pool, history, sortMode, mediaMode);
      if (typeof chosen !== "object" || chosen === null) continue;
      await openDirect(chosen, root, watchMode);
      continue;
    }

    if (next === "filter") {
      const asked = await promptSizeRange("");
      if (typeof asked === "symbol") continue;
      sizeRange = asked;
      continue outer;
    }

    if (next === "changeFolder") {
      const picked = await chooseFolder(undefined, root);
      if (typeof picked !== "string") break;
      root = picked;
      settings = {
        ...settings,
        lastFolder: picked,
        recentFolders: withRecentFolder(settings.recentFolders ?? [], picked, settings.recentLimit),
      };
      await saveSettings(settings).catch(() => {});
      continue outer;
    }

    if (next === "changeMode") {
      const switched = await chooseMediaMode(mediaMode);
      if (typeof switched !== "string") break;
      mediaMode = switched;
      log.info(`Now ${MODE_LABELS[mediaMode].toLowerCase()}`);
      settings = { ...settings, mode: mediaMode };
      await saveSettings(settings).catch(() => {});
      continue outer;
    }

    if (next === "roll1" || next === "roll3" || next === "roll5" || next === "rollAll") {
      count = next === "rollAll" ? pool.length : Number(next.slice(4));
      continue outer;
    }

    if (next === "help") {
      for (const line of panel(helpLines(), "shortcuts")) log.message(line);
      continue;
    }

    continue outer; // "again": rescan and roll the same way
  }

  outro(color.dim("bye"));
  return 0;
}

/** After a fire-and-forget launch, block until the user says the player is done. */
async function waitForReturn(): Promise<void> {
  await text({ message: "Press enter when the player is closed…", placeholder: "" });
}

async function searchSort(): Promise<SortMode | symbol> {
  const chosen = await searchSelect<SortMode>({
    message: "Sort library by",
    options: SORT_MODES.map((mode) => ({ value: mode, label: mode })),
    maxVisible: 4,
  });
  return isSearchCancel(chosen) ? Symbol.for("rndvid.cancel") : chosen;
}

/** Sentinel meaning "the recent list had nothing usable in it". */
const CANCEL_RECENT = Symbol.for("rndvid.cancel");

type BarChoice =
  | "again"
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
  | "changeMode"
  | "help"
  | "quit"
  | null;

/**
 * Single-keystroke action bar shown after each roll.
 *
 * Returns the chosen action, or null when the user pressed Ctrl+C.
 */
async function actionBar(): Promise<BarChoice> {
  const pressed = await readOneKey();
  if (isOneKeyCancel(pressed)) return null;

  // Enter is the default: roll again the same way.
  if (pressed.char === "" && pressed.name === "return") return "again";

  switch (shortcutFor(pressed.char.toLowerCase())) {
    case "roll1":
      return "roll1";
    case "roll3":
      return "roll3";
    case "roll5":
      return "roll5";
    case "rollAll":
      return "rollAll";
    case "tree":
      return "tree";
    case "recentFiles":
      return "recentFiles";
    case "recentFolders":
      return "recentFolders";
    case "filter":
      return "filter";
    case "undo":
      return "undo";
    case "toggleWatched":
      return "toggleWatched";
    case "library":
      return "library";
    case "changeFolder":
      return "changeFolder";
    case "quit":
      return "quit";
    case "help":
      return "help";
    default:
      // `m` isn't in the shared table because it means different things in
      // different prompts; here it switches media.
      return pressed.char.toLowerCase() === "m" ? "changeMode" : "again";
  }
}

/**
 * Turn a recent-file record back into something openable.
 *
 * Recent entries deliberately store only folder + relative path, so they survive
 * a rescan and don't bloat; the file may since have moved or been deleted, in
 * which case this returns null rather than opening the wrong thing.
 */
async function resolveRecent(entry: RecentFile): Promise<MediaFile | null> {
  const full = path.join(entry.folder, ...entry.rel.split("/"));
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) return null;
    const dot = entry.name.lastIndexOf(".");
    return {
      path: full,
      name: entry.name,
      ext: dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "",
      rel: entry.rel,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

/** Open a single file directly, recording history and recent entries. */
async function openDirect(
  file: MediaFile,
  folder: string,
  wait: boolean,
): Promise<void> {
  log.message(`\n${describeFile(file)}`);

  const history = await History.load(folder);
  const token = history.markWatched(file);
  await history.save().catch(() => {});
  await recordRecentFile({
    folder,
    rel: file.rel,
    name: file.name,
    openedAt: Date.now(),
  }).catch(() => {});
  void token;

  const startedAt = Date.now();
  const result = await openInDefaultPlayer(file.path, { wait });
  if (!result.ok) {
    log.error(`Could not open ${file.name}: ${result.error ?? "unknown error"}`);
  } else if (!result.waited) {
    await waitForReturn();
  }

  const sessionMs = Date.now() - startedAt;
  if (sessionMs > 30_000) {
    history.recordSession(file, sessionMs);
    await history.save().catch(() => {});
    log.message(color.dim(`  watched ${formatDuration(sessionMs)}`));
  }
}

const code = await (async () => {
  try {
    return await main();
  } catch (err) {
    log.error((err as Error).message ?? String(err));
    if (process.env["RNDVID_DEBUG"]) process.stderr.write(`${(err as Error).stack}\n`);
    return 1;
  }
})();

process.exit(code);
