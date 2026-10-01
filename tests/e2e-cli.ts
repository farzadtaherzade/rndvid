/**
 * End-to-end CLI tests driven through `--dry-run`, which exercises the real
 * pipeline (scan, filter, history, roll) without needing a TTY.
 *
 * The interactive prompts can't be driven here: node-pty's ConPTY backend on this
 * machine delivers no input to the child — not even to a plain readline script —
 * so keystroke-driven tests would only prove the harness is broken. Key handling
 * is covered in search-select.test.ts with injected streams instead.
 *
 *   bun run test:e2e
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const REPO = path.resolve(import.meta.dir, "..");
const SANDBOX = path.join(os.tmpdir(), "rndvid-e2e");
const DATA = path.join(SANDBOX, "appdata");
const LIBRARY = path.join(SANDBOX, "library");

const MIB = 1024 * 1024;

/** Videos the fixture holds. Sizes are chosen so size filters are predictable. */
const FIXTURE: readonly (readonly [string, number])[] = [
  ["alpha.mp4", 700],
  ["bravo.mkv", 1500],
  ["charlie.avi", 700],
  ["delta.mov", 90],
  ["echo.webm", 2],
  ["Season 1/foxtrot.mp4", 800],
  ["Extras/golf.mkv", 400],
];

/**
 * Same files, wrong types — must never be picked in video mode.
 *
 * `clip.mp3` is deliberately here: audio mode should find it, which is how the
 * suite proves the modes are genuinely separate rather than one permissive set.
 */
const DECOYS = ["notes.txt", "cover.jpg", "archive.rar", "Extras/readme.md", "clip.mp3"];

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    if (detail) {
      console.log(detail.split("\n").slice(-12).map((l) => `        ${l}`).join("\n"));
    }
  }
}

function plain(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

interface Run {
  code: number;
  out: string;
}

/**
 * Run the CLI with a sandboxed data dir. Never inherits a real profile.
 *
 * `--mode video` is injected unless the caller asks for another mode, so each
 * case is independent of whatever mode the previous run remembered in settings.
 */
function run(args: string[], env: Record<string, string> = {}): Run {
  const hasMode = args.some((a) => a === "--mode" || a.startsWith("--mode="));
  const finalArgs = hasMode ? args : ["--mode", "video", ...args];

  const result = spawnSync(process.execPath, ["run", path.join(REPO, "src", "index.ts"), ...finalArgs], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      RNDVID_DATA_DIR: DATA,
      ...env,
    } as NodeJS.ProcessEnv,
  });
  return { code: result.status ?? -1, out: plain(result.stdout ?? "") + plain(result.stderr ?? "") };
}

/**
 * The roll listing lines, as relative paths in roll order.
 *
 * Clack prefixes every logged line with a `│` gutter, so the leading bar and
 * whitespace are both optional before the position number.
 */
/**
 * Pull the rolled paths out of the listing.
 *
 * Each pick is one line: `  <pos>  <rel path>  <size>`. The size is stripped
 * from the tail rather than pattern-matched in place, because filenames contain
 * digits and spaces ("Season 1/ep.mp4") that any position-based regex misreads.
 */
/**
 * Pull the rolled paths out of the listing.
 *
 * Each pick is one line: `  <pos>  <rel path>  <size>`. The size is matched
 * explicitly and stripped from the tail rather than split on whitespace, because
 * sizes contain a space ("800 MiB") and paths contain spaces and digits
 * ("Season 1/ep.mp4"). Long paths are elided by the CLI, so this returns the
 * same `…`-prefixed form when it has to.
 */
function rolled(text: string): string[] {
  const block = text.split(/Rolled [^:]*:/)[1] ?? "";
  const picks: string[] = [];
  const SIZE = String.raw`\d[\d.,]*\s*(?:B|[KMGT]iB)\s*$`;
  const line = new RegExp(String.raw`^[^\S\n]*[│|][^\S\n]*\d{1,3}\s+(\S.*?)\s{2,}${SIZE}`);
  for (const raw of block.split("\n")) {
    const match = line.exec(raw);
    if (match) picks.push(match[1]!);
  }
  return picks;
}

async function makeFixture(): Promise<void> {
  await fs.rm(SANDBOX, { recursive: true, force: true });
  await fs.mkdir(DATA, { recursive: true });

  for (const [rel, sizeMiB] of FIXTURE) {
    const full = path.join(LIBRARY, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const handle = await fs.open(full, "w");
    await handle.truncate(sizeMiB * MIB);
    await handle.close();
  }
  for (const decoy of DECOYS) {
    const full = path.join(LIBRARY, decoy);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "x");
  }
}

async function historyFiles(): Promise<string[]> {
  const dir = path.join(DATA, "history");
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function seedHistory(entries: Record<string, { plays: number }>): Promise<void> {
  const { folderKey } = await import("../src/config.ts");
  const dir = path.join(DATA, "history");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${folderKey(LIBRARY)}.json`),
    JSON.stringify({
      version: 1,
      folder: LIBRARY,
      entries: Object.fromEntries(
        Object.entries(entries).map(([rel, e]) => [rel, { lastPlayed: Date.now(), plays: e.plays }]),
      ),
    }),
    "utf8",
  );
}

async function main(): Promise<void> {
  await makeFixture();
  const total = FIXTURE.length;

  // ---- scan reports the library ----
  console.log("scan");
  {
    const { code, out } = run(["--folder", LIBRARY, "--count", "1", "--dry-run"]);
    check("exits 0", code === 0, out);
    check(`reports ${total} videos`, new RegExp(`\\b${total} videos\\b`).test(out), out);
    check("reports folders visited", /\d+ folders?/.test(out), out);
    check("reports total size", /GiB|MiB/.test(out), out);
    check("rolled one file", /Rolled 1 video:/.test(out), out);
    check("ignored every decoy", !rolled(out).some((r) => /\.(txt|jpg|rar|md|mp3)$/.test(r)), out);

    // The .mp3 decoy proves the mode filter is doing real work: video mode skips
    // it, and the audio case below finds it.
    const audioSees = run([
      "--folder",
      LIBRARY,
      "--mode",
      "audio",
      "--count",
      "20",
      "--dry-run",
    ]);
    check(
      "audio mode does find the mp3 decoy",
      rolled(audioSees.out).includes("clip.mp3"),
      audioSees.out,
    );
  }

  // ---- recursive scan reaches subfolders ----
  {
    let sawNested = 0;
    for (let i = 0; i < 12; i += 1) {
      const { out } = run(["--folder", LIBRARY, "--count", "7", "--dry-run"]);
      const names = rolled(out);
      if (names.includes("Season 1/foxtrot.mp4") || names.includes("Extras/golf.mkv")) sawNested += 1;
    }
    check("picks from subfolders", sawNested > 0, `nested appeared in ${sawNested}/12 rolls`);
  }

  // ---- uniqueness ----
  {
    let rounds = 0;
    let dupes = 0;
    for (let i = 0; i < 15; i += 1) {
      const { out } = run(["--folder", LIBRARY, "--count", "5", "--dry-run"]);
      const names = rolled(out);
      if (names.length !== 5) continue;
      rounds += 1;
      if (new Set(names).size !== 5) dupes += 1;
    }
    check(`no duplicates in ${rounds} rolls of 5`, rounds === 15 && dupes === 0, `dupes=${dupes}`);
  }

  // ---- count is clamped to what's available ----
  {
    const { out } = run(["--folder", LIBRARY, "--count", "99", "--dry-run"]);
    check("clamps an oversized roll", new RegExp(`Rolled ${total} (?:video|file|book)`).test(out), out);
    check("warns about clamping", /Only \d+ available/.test(out), out);
  }

  // ---- size filters ----
  {
    const min = run(["--folder", LIBRARY, "--size", "1gb-", "--count", "1", "--dry-run"]);
    check("min-only filter narrows the pool", /1 left after size filter/.test(min.out), min.out);
    check("min-only filter picks bravo.mkv", rolled(min.out).join() === "bravo.mkv", min.out);

    const range = run(["--folder", LIBRARY, "--size", "600mb-800mb", "--count", "5", "--dry-run"]);
    check("range filter reports its size", /left after size filter/.test(range.out), range.out);
    for (const name of rolled(range.out)) {
      const m = FIXTURE.find(([rel]) => rel === name);
      check(`${name} is inside 600-800mb`, m !== undefined && m[1] >= 600 && m[1] <= 800, range.out);
    }

    const none = run(["--folder", LIBRARY, "--size", "99gb-", "--count", "1", "--dry-run"]);
    check("impossible filter yields nothing", /left nothing|0 left/.test(none.out), none.out);

    const bad = run(["--folder", LIBRARY, "--size", "2gb-200mb", "--count", "1", "--dry-run"]);
    check("rejects an inverted range", bad.code === 1 && /minimum is larger/.test(bad.out), bad.out);

    const junk = run(["--folder", LIBRARY, "--size", "big", "--count", "1", "--dry-run"]);
    check("rejects a non-size", junk.code === 1 && /not a size/.test(junk.out), junk.out);
  }

  // ---- dry run writes no history ----
  {
    await fs.rm(path.join(DATA, "history"), { recursive: true, force: true });
    run(["--folder", LIBRARY, "--count", "2", "--dry-run"]);
    check("dry run records nothing watched", (await historyFiles()).length === 0);
  }

  // ---- exclude watched ----
  {
    await seedHistory({ "alpha.mp4": { plays: 1 }, "charlie.avi": { plays: 2 } });
    const { out } = run([
      "--folder",
      LIBRARY,
      "--count",
      "4",
      "--dry-run",
      "--exclude-watched",
    ]);
    check("reports the watched count", /2 watched before/.test(out), out);
    check("narrows to unwatched", /5 unwatched of 7/.test(out), out);
    check("skips alpha.mp4", !rolled(out).includes("alpha.mp4"), out);
    check("skips charlie.avi", !rolled(out).includes("charlie.avi"), out);
    check("rolled four unwatched", rolled(out).length === 4, out);
  }

  // ---- everything watched ----
  {
    const all = Object.fromEntries(FIXTURE.map(([rel]) => [rel, { plays: 1 }]));
    await seedHistory(all);
    const { out } = run([
      "--folder",
      LIBRARY,
      "--count",
      "1",
      "--dry-run",
      "--exclude-watched",
    ]);
    check("says so when nothing is unwatched", /watched already/.test(out), out);
  }
  await fs.rm(path.join(DATA, "history"), { recursive: true, force: true });

  // ---- library listing ----
  {
    const { out } = run(["--folder", LIBRARY, "--library", "--dry-run"]);
    check("library mode lists files", /Library \(\d+ videos/.test(out), out);
    check("library includes nested files", out.includes("Season 1/foxtrot.mp4"), out);
    check("library shows sizes", /MiB|GiB/.test(out), out);
    check("library excludes decoys", !out.includes("notes.txt"), out);
  }

  // ---- bad input never reaches the TUI ----
  {
    const help = run(["--help"]);
    check("--help exits 0", help.code === 0, help.out);
    check("--help documents --dry-run", help.out.includes("--dry-run"), help.out);

    const missing = run(["--folder", path.join(SANDBOX, "does-not-exist")]);
    check("missing folder exits 0 with an error", missing.code === 0, missing.out);
    check("missing folder is reported", /Folder not found/.test(missing.out), missing.out);

    const badOpt = run(["--nope"]);
    check("unknown option exits 2", badOpt.code === 2, badOpt.out);

    const badCount = run(["--count", "zero"]);
    check("bad --count exits 2", badCount.code === 2, badCount.out);

    const badCount2 = run(["--count", "0"]);
    check("zero --count exits 2", badCount2.code === 2, badCount2.out);
  }

  // ---- empty folder ----
  {
    const empty = path.join(SANDBOX, "empty");
    await fs.mkdir(empty, { recursive: true });
    await fs.writeFile(path.join(empty, "readme.txt"), "x");
    const { out } = run(["--folder", empty, "--dry-run"]);
    check("reports an empty library", /No video files/.test(out), out);
    // Extensions are listed in sorted order, so assert on the actual list rather
// than the display order.
check("lists supported formats", /Supported: avi flv m4v mkv/.test(out), out);
    check("reports the folders it checked", /Checked \d+ folders/.test(out), out);
    await fs.rm(empty, { recursive: true, force: true });
  }

  // ---- nested folder is its own library ----
  {
    const { out } = run(["--folder", path.join(LIBRARY, "Season 1"), "--count", "1", "--dry-run"]);
    check("scans a nested folder directly", /1 video\b/.test(out), out);
    check("finds the file inside it", rolled(out).join() === "foxtrot.mp4", out);
  }

  // ---- media modes ----
  console.log("modes");
  {
    // Add book and audio files alongside the videos in the fixture.
    for (const [rel, sizeMiB] of [
      ["shelf/book1.epub", 3],
      ["shelf/book2.pdf", 12],
      ["shelf/audiobook.m4b", 180],
      ["music/track1.mp3", 8],
      ["music/track2.flac", 40],
    ] as const) {
      const full = path.join(LIBRARY, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      const handle = await fs.open(full, "w");
      await handle.truncate(sizeMiB * MIB);
      await handle.close();
    }

    const video = run(["--folder", LIBRARY, "--mode", "video", "--count", "3", "--dry-run"]);
    check("video mode ignores books", !rolled(video.out).some((r) => /\.(epub|pdf|m4b)$/.test(r)), video.out);
    check("video mode ignores audio", !rolled(video.out).some((r) => /\.(mp3|flac)$/.test(r)), video.out);

    const book = run(["--folder", LIBRARY, "--mode", "book", "--count", "3", "--dry-run"]);
    check("book mode reports books", /scanned 3 books/.test(book.out), book.out);
    const bookNames = rolled(book.out);
    check("book mode returns only books", bookNames.every((n) => /\.(epub|pdf|m4b)$/.test(n)), book.out);
    check("book mode includes the audiobook", bookNames.includes("shelf/audiobook.m4b"), book.out);
    check("book mode excludes videos", !bookNames.some((n) => /\.(mp4|mkv|avi)$/.test(n)), book.out);

    // Roll the whole set so membership is deterministic: the fixture has 4 audio
    // files (2 tracks, the audiobook, and the clip.mp3 decoy).
    const audio = run(["--folder", LIBRARY, "--mode", "audio", "--count", "9", "--dry-run"]);
    check("audio mode reports audio files", /scanned 4 files/.test(audio.out), audio.out);
    check("audio summary uses the right noun", /4 audio files · /.test(audio.out), audio.out);
    const audioNames = rolled(audio.out);
    check("audio mode returns only audio", audioNames.every((n) => /\.(mp3|flac|m4b)$/.test(n)), audio.out);
    check("audio mode includes the audiobook", audioNames.includes("shelf/audiobook.m4b"), audio.out);
    check("audio mode excludes books", !audioNames.some((n) => /\.(epub|pdf)$/.test(n)), audio.out);
    check("audio mode excludes videos", !audioNames.some((n) => /\.(mp4|mkv|avi|mov|webm)$/.test(n)), audio.out);

    const badMode = run(["--folder", LIBRARY, "--mode", "podcast", "--dry-run"]);
    check("rejects an unknown mode", badMode.code === 2 && /--mode must be one of/.test(badMode.out), badMode.out);

    // Book mode against a video-only folder should say what it looked for.
    const noBooks = run(["--folder", path.join(LIBRARY, "Season 1"), "--mode", "book", "--dry-run"]);
    check("book mode explains an empty result", /No book files/.test(noBooks.out), noBooks.out);
    check("book mode lists book formats", /Supported: aac azw/.test(noBooks.out), noBooks.out);

    const noAudio = run(["--folder", path.join(LIBRARY, "Season 1"), "--mode", "audio", "--dry-run"]);
    check("audio mode explains an empty result", /No audio files/.test(noAudio.out), noAudio.out);
  }

  // ---- depth cap ----
  console.log("depth cap");
  {
    // A chain deeper than the default cap of 4.
    const deep = path.join(SANDBOX, "deep");
    let current = deep;
    await fs.mkdir(current, { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      current = path.join(current, `lvl${i + 1}`);
      await fs.mkdir(current, { recursive: true });
    }
    await fs.writeFile(path.join(current, "buried.mp4"), "x");
    await fs.writeFile(path.join(deep, "top.mp4"), "x");

    // --mode is explicit throughout: the fixture folder has books and audio in it
    // now, so the remembered mode would otherwise change what gets counted.
    const capped = run(["--folder", deep, "--mode", "video", "--count", "1", "--dry-run"]);
    check("default cap misses deep files", rolled(capped.out).join() === "top.mp4", capped.out);
    check("cap is stated in the scan line", /depth ≤ 4/.test(capped.out), capped.out);
    check("truncation is reported", /Depth cap of 4 reached/.test(capped.out), capped.out);
    check("truncation suggests the override", /--max-depth 0/.test(capped.out), capped.out);
    check("truncation names an example folder", /lvl1/.test(capped.out), capped.out);

    // Rolling 2 of the 2 found files avoids depending on which one a single
    // random draw happens to pick.
    const unbounded = run([
      "--folder",
      deep,
      "--mode",
      "video",
      "--count",
      "2",
      "--dry-run",
      "--max-depth",
      "0",
    ]);
    check(
      "max-depth 0 finds the buried file",
      rolled(unbounded.out).length === 2 &&
        rolled(unbounded.out).some((n) => n.endsWith("buried.mp4")),
      unbounded.out,
    );
    check("unbounded scan says nothing about a cap", !/depth ≤/.test(unbounded.out), unbounded.out);
    check("unbounded scan reports no truncation", !/Depth cap/.test(unbounded.out), unbounded.out);

    const shallow = run([
      "--folder",
      deep,
      "--mode",
      "video",
      "--count",
      "1",
      "--dry-run",
      "--max-depth",
      "1",
    ]);
    check("max-depth 1 stays at the root", rolled(shallow.out).join() === "top.mp4", shallow.out);

    const badDepth = run(["--folder", deep, "--mode", "video", "--max-depth", "-2", "--dry-run"]);
    check("rejects a negative depth", badDepth.code === 2, badDepth.out);
    check("explains the depth error", /--max-depth must be 0 or a positive integer/.test(badDepth.out), badDepth.out);

    await fs.rm(deep, { recursive: true, force: true });
  }

  // ---- resume prompt and recent folders ----
  console.log("resume + recents");
  {
    // Two libraries so "the last folder" is distinguishable from the fixture.
    const second = path.join(SANDBOX, "second-library");
    await fs.mkdir(second, { recursive: true });
    const handle = await fs.open(path.join(second, "solo.mkv"), "w");
    await handle.truncate(900 * MIB);
    await handle.close();

    // Dry-run never prompts, so it stands in for the browser path.
    run(["--folder", LIBRARY, "--mode", "video", "--count", "1", "--dry-run"]);
    const settingsAfter = JSON.parse(
      await fs.readFile(path.join(DATA, "settings.json"), "utf8"),
    );
    check(
      "remembers the library as a recent folder",
      Array.isArray(settingsAfter.recentFolders) &&
        settingsAfter.recentFolders.some((f: string) =>
          f.toLowerCase() === LIBRARY.toLowerCase(),
        ),
      JSON.stringify(settingsAfter),
    );

    // Opening a second library prepends it, most recent first.
    run(["--folder", second, "--mode", "video", "--count", "1", "--dry-run"]);
    const settingsBoth = JSON.parse(
      await fs.readFile(path.join(DATA, "settings.json"), "utf8"),
    );
    check(
      "newest folder is first in recents",
      settingsBoth.recentFolders[0]?.toLowerCase() === second.toLowerCase(),
      JSON.stringify(settingsBoth.recentFolders),
    );
    // Earlier sections ran against other folders, so assert membership rather than
    // an exact count.
    check(
      "keeps both libraries in recents",
      settingsBoth.recentFolders.some((f: string) => f.toLowerCase() === LIBRARY.toLowerCase()) &&
        settingsBoth.recentFolders.some((f: string) => f.toLowerCase() === second.toLowerCase()),
      JSON.stringify(settingsBoth.recentFolders),
    );

    // A deleted folder must not linger in the list.
    await fs.rm(second, { recursive: true, force: true });
    run(["--folder", LIBRARY, "--mode", "video", "--count", "1", "--dry-run"]);
    const afterDelete = JSON.parse(
      await fs.readFile(path.join(DATA, "settings.json"), "utf8"),
    );
    check(
      "a removed folder stops being recent",
      !afterDelete.recentFolders.some((f: string) => f.toLowerCase() === second.toLowerCase()),
      JSON.stringify(afterDelete.recentFolders),
    );

    check("remembers the mode too", afterDelete.mode === "video", JSON.stringify(afterDelete));

    // A dry run must not leave recent-file records behind, since nothing opened.
    const recentPath = path.join(DATA, "recent.json");
    const recentExists = await fs
      .stat(recentPath)
      .then(() => true)
      .catch(() => false);
    check("dry run records no recent files", !recentExists);

    await fs.mkdir(second, { recursive: true });
  }

  // ---- undo ----
  console.log("undo");
  {
    // Undo rewrites the history file, so drive it through the History API the
    // action bar uses rather than trying to synthesise a keystroke.
    const { History } = await import("../src/history.ts");
    const file = {
      path: path.join(LIBRARY, "alpha.mp4"),
      name: "alpha.mp4",
      ext: "mp4",
      rel: "alpha.mp4",
      size: 700 * MIB,
      mtimeMs: 0,
    };

    const history = await History.load(LIBRARY);
    const token = history.markWatched(file);
    check("a fresh mark has no prior state", token === null);
    history.recordSession(file, 1_200_000);
    await history.save();

    const reloaded = await History.load(LIBRARY);
    check("mark and session persist", reloaded.watchedMs(file) === 1_200_000);

    const undoToken = reloaded.markWatched(file);
    check("re-mark returns the previous entry", undoToken !== null && undoToken.plays === 1);
    reloaded.undo(file, undoToken);
    await reloaded.save();

    const afterUndo = await History.load(LIBRARY);
    check("undo restores the play count", afterUndo.watchedMs(file) === 1_200_000);

    const removeToken = afterUndo.undo(file, null);
    check("undo with no prior entry removes the key", removeToken === true);
    await afterUndo.save();

    const finalHistory = await History.load(LIBRARY);
    check("undo drops the entry entirely", finalHistory.has(file) === false);
  }

  // ---- settings round-trip ----
  // Runs last: each invocation overwrites lastFolder, so this asserts on the
  // most recent one rather than whichever folder an earlier case happened to use.
  {
    run(["--folder", LIBRARY, "--count", "1", "--dry-run"]);
    const settingsPath = path.join(DATA, "settings.json");
    const saved = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    check(
      "remembers the last folder",
      String(saved.lastFolder).toLowerCase() === LIBRARY.toLowerCase(),
      JSON.stringify(saved),
    );
  }

  console.log(
    failures === 0
      ? `\nall ${checks} e2e checks passed`
      : `\n${failures} of ${checks} e2e checks failed`,
  );
  await fs.rm(SANDBOX, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

await main();
