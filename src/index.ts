#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs/promises";

import { scanMedia, DEFAULT_MAX_DEPTH, type MediaFile } from "./scan.ts";
import { loadSettings, saveSettings, type Settings } from "./config.ts";
import { History } from "./history.ts";
import { parseSizeRange, filterBySize, describeLibrary, type SizeRange } from "./filters.ts";
import { pickMany } from "./random.ts";
import { openInDefaultPlayer } from "./player.ts";
import {
  chooseFolder,
  chooseMediaMode,
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
import { MEDIA_MODES, MODE_HINTS, MODE_LABELS, isMediaMode, type MediaMode } from "./extensions.ts";
import {
  color,
  confirm,
  formatBytes,
  intro,
  isCancel,
  log,
  outro,
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
  return chooseFolder(undefined, settings.lastFolder);
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
  settings = { ...settings, lastFolder: root, mode: mediaMode };
  await saveSettings(settings).catch(() => {
    /* a read-only APPDATA shouldn't stop the run */
  });

  let watchMode = settings.waitForPlayer !== false && !args.detach;
  let sortMode: SortMode = "name";

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

      // Record before launching so a player that crashes still counts as watched.
      history.markWatched(file);
      await history.save().catch(() => {});

      const result = await openInDefaultPlayer(file.path, { wait: watchMode });
      if (!result.ok) {
        log.error(`Could not open ${file.name}: ${result.error ?? "unknown error"}`);
      } else if (!result.waited) {
        // Fallback path via `start`: we can't see when the player exits.
        await waitForReturn();
      }
    }

    // After a roll, offer the things you might reasonably do next rather than a bare
// yes/no, since the answer is often "different folder" or "different media".
const next = await text({
      message: "Roll again? (y = same, n = pick another, m = change media, d = change folder)",
      placeholder: "y",
      initialValue: "y",
      validate: (value) => {
        const key = value.trim().toLowerCase();
        return ["", "y", "yes", "n", "no", "m", "d"].includes(key) ? undefined : "answer y, n, m, or d";
      },
    });
    if (isCancel(next)) break;

    const answer = String(next).trim().toLowerCase();

    if (answer === "n" || answer === "d") {
      const picked = await chooseFolder(undefined, root);
      if (typeof picked !== "string") break;
      root = picked;
      settings = { ...settings, lastFolder: picked };
      await saveSettings(settings).catch(() => {});
      continue outer;
    }

    if (answer === "m") {
      const switched = await chooseMediaMode(mediaMode);
      if (typeof switched !== "string") break;
      mediaMode = switched;
      log.info(`Now ${MODE_LABELS[mediaMode].toLowerCase()}`);
      settings = { ...settings, mode: mediaMode };
      await saveSettings(settings).catch(() => {});
      continue outer;
    }

    break;
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
