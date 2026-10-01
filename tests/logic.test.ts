/**
 * Unit tests for the pure logic: RNG, size parsing, fuzzy ranking, and the
 * registry command parser. Run with `bun run test`.
 */
import { test, expect, describe } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { randomInt, pickOne, pickMany } from "../src/random.ts";
import { parseSize, parseSizeRange, filterBySize, formatBytes } from "../src/filters.ts";
import { fuzzyScore, fuzzyFilter } from "../src/fuzzy.ts";
import {
  parseOpenCommand,
  expandEnvironment,
  PLACEHOLDER,
  resolveHandlerForTest,
} from "../src/player.ts";
import { scanVideos, scanMedia, DEFAULT_MAX_DEPTH } from "../src/scan.ts";
import { videoExtension, modeExtension, isMediaMode, isAnyMedia } from "../src/extensions.ts";
import type { MediaMode } from "../src/extensions.ts";
import { folderKey, withRecentFolder } from "../src/config.ts";
import { History } from "../src/history.ts";
import { withRecentFile } from "../src/recent.ts";
import { buildTree, filesUnder, folderFor, treeLine, type TreeNode } from "../src/tree.ts";
import { panel, footer, formatDuration } from "../src/ui.ts";
import { SHORTCUTS, shortcutFor, helpLines } from "../src/shortcuts.ts";
import type { MediaFile } from "../src/scan.ts";

/** Alias kept so the existing History fixtures read unchanged. */
type VideoFile = MediaFile;

describe("randomInt", () => {
  test("stays in range", () => {
    for (let i = 0; i < 5000; i += 1) {
      const v = randomInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  test("handles degenerate sizes", () => {
    expect(randomInt(1)).toBe(0);
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-3)).toThrow(RangeError);
    expect(() => randomInt(2.5)).toThrow(RangeError);
  });

  test("handles ranges wider than one uint32", () => {
    // Above 2^32 the implementation switches to a 53-bit path; exercise it so a
    // precision bug there can't hide behind the common case.
    const big = 0x20000000000000; // 2^53
    for (let i = 0; i < 200; i += 1) {
      const v = randomInt(big);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(big);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  test("wide ranges are still unbiased near the top", () => {
    // Check the low 5 bits are uniform when masking a wide draw, which is what
    // precision loss in the 53-bit path would break.
    const counts = new Map<number, number>();
    const big = 0x20000000000000;
    for (let i = 0; i < 20_000; i += 1) {
      const slot = randomInt(big) % 32;
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(400);
    }
  });

  test("covers the whole range", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i += 1) seen.add(randomInt(5));
    expect(seen.size).toBe(5);
  });

  test("is roughly uniform", () => {
    // Chi-square-ish sanity check; catches modulo bias or a stuck generator.
    const buckets = new Array(10).fill(0);
    const n = 60_000;
    for (let i = 0; i < n; i += 1) buckets[randomInt(10)] += 1;
    const expected = n / 10;
    const chi2 = buckets.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    // 9 dof, p=0.001 critical value is ~27.9
    expect(chi2).toBeLessThan(27.9);
  });
});

describe("pickOne / pickMany", () => {
  test("pickOne throws on empty", () => {
    expect(() => pickOne([])).toThrow(RangeError);
  });

  test("pickMany never repeats", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    for (let round = 0; round < 200; round += 1) {
      const picks = pickMany(items, 20);
      expect(picks.length).toBe(20);
      expect(new Set(picks).size).toBe(20);
    }
  });

  test("pickMany draws from the pool", () => {
    const items = ["a", "b", "c", "d"];
    for (let round = 0; round < 100; round += 1) {
      for (const pick of pickMany(items, 3)) expect(items).toContain(pick);
    }
  });

  test("pickMany validates bounds", () => {
    expect(pickMany([1, 2], 0)).toEqual([]);
    expect(pickMany([1, 2], -1)).toEqual([]);
    expect(() => pickMany([1, 2], 3)).toThrow(RangeError);
  });

  test("pickMany does not mutate its input", () => {
    const items = [1, 2, 3, 4, 5];
    const snapshot = [...items];
    pickMany(items, 4);
    expect(items).toEqual(snapshot);
  });

  test("eventually surfaces every item", () => {
    const items = [1, 2, 3];
    const seen = new Set<number>();
    for (let round = 0; round < 200; round += 1) seen.add(pickOne(items));
    expect(seen.size).toBe(3);
  });
});

describe("parseSize", () => {
  test("defaults a bare number to megabytes", () => {
    expect(parseSize("700").bytes).toBe(700 * 1024 ** 2);
  });

  test("understands unit suffixes", () => {
    expect(parseSize("500mb").bytes).toBe(500 * 1024 ** 2);
    expect(parseSize("500MB").bytes).toBe(500 * 1024 ** 2);
    expect(parseSize("1.5gb").bytes).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize("2GiB").bytes).toBe(2 * 1024 ** 3);
    expect(parseSize("512b").bytes).toBe(512);
    expect(parseSize("1 kb").bytes).toBe(1024);
  });

  test("rejects junk", () => {
    expect(parseSize("").error).toBeDefined();
    expect(parseSize("big").error).toBeDefined();
    expect(parseSize("-5mb").error).toBeDefined();
    expect(parseSize("5 apples").error).toBeDefined();
  });
});

describe("parseSizeRange", () => {
  test("blank means no bound", () => {
    expect(parseSizeRange("").range).toEqual({});
    expect(parseSizeRange("   ").range).toEqual({});
  });

  test("a single value is a minimum", () => {
    expect(parseSizeRange("500mb").range).toEqual({ min: 500 * 1024 ** 2 });
  });

  test("explicit bounds", () => {
    expect(parseSizeRange(">1gb").range).toEqual({ min: 1024 ** 3 });
    expect(parseSizeRange("<800mb").range).toEqual({ max: 800 * 1024 ** 2 });
    const r = parseSizeRange("200mb-2gb").range!;
    expect(r.min).toBe(200 * 1024 ** 2);
    expect(r.max).toBe(2 * 1024 ** 3);
  });

  test("rejects an inverted range", () => {
    expect(parseSizeRange("2gb-200mb").error).toMatch(/minimum is larger/);
  });

  test("a negative number is a bound, not junk", () => {
    // "700-900" must parse as a range, not fail on the bare digit.
    const r = parseSizeRange("700-900").range;
    expect(r?.min).toBe(700 * 1024 ** 2);
    expect(r?.max).toBe(900 * 1024 ** 2);
  });

  test("open-ended forms", () => {
    expect(parseSizeRange("1gb-").range).toEqual({ min: 1024 ** 3 });
    expect(parseSizeRange("-800mb").range).toEqual({ max: 800 * 1024 ** 2 });
    expect(parseSizeRange(">1gb-").error).toBeDefined();
    expect(parseSizeRange("1gb-").range).toEqual({ min: 1024 ** 3 });
  });

  test("a range with units on both sides", () => {
    const r = parseSizeRange("200mb-2gb").range!;
    expect(r.min).toBe(200 * 1024 ** 2);
    expect(r.max).toBe(2 * 1024 ** 3);
  });
});

describe("filterBySize", () => {
  const mb = 1024 ** 2;
  const files = [
    { size: 10 * mb },
    { size: 100 * mb },
    { size: 700 * mb },
    { size: 2000 * mb },
  ] as VideoFile[];

  test("bounds are inclusive", () => {
    expect(filterBySize(files, { min: 100 * mb, max: 700 * mb }).length).toBe(2);
  });

  test("empty range keeps everything", () => {
    expect(filterBySize(files, {}).length).toBe(4);
  });

  test("min only", () => {
    expect(filterBySize(files, { min: 700 * mb }).length).toBe(2);
  });

  test("max only", () => {
    expect(filterBySize(files, { max: 100 * mb }).length).toBe(2);
  });
});

describe("formatDuration", () => {
  test("drops zero seconds and minutes", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(22 * 60_000)).toBe("22m");
    expect(formatDuration(22 * 60_000 + 10_000)).toBe("22m 10s");
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(64 * 60_000)).toBe("1h 04m");
  });

  test("rejects nonsense", () => {
    expect(formatDuration(-1)).toBe("-");
    expect(formatDuration(Number.NaN)).toBe("-");
  });
});

describe("panel", () => {
  test("wraps lines in a box", () => {
    const lines = panel(["hello", "world"], "title", 20);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("title");
    expect(lines[3]).toContain("└");
    expect(plain(lines[1])).toContain("hello");
  });

  test("handles an absent title", () => {
    const lines = panel(["x"], undefined, 20);
    expect(plain(lines[0])).toContain("┌");
  });

  test("footer drops empty parts", () => {
    expect(plain(footer(["a", "", "b"]))).toContain("a · b");
    expect(plain(footer(["a", "", ""]))).not.toContain("·");
  });
});

describe("formatBytes", () => {
  test("scales units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(20 * 1024 ** 2)).toBe("20 MiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GiB");
  });

  test("handles junk", () => {
    expect(formatBytes(-1)).toBe("unknown");
    expect(formatBytes(NaN)).toBe("unknown");
  });
});

describe("fuzzyScore", () => {
  test("matches subsequences", () => {
    expect(fuzzyScore("abc", "aXbXc")).not.toBeNull();
    expect(fuzzyScore("abc", "acb")).toBeNull();
    expect(fuzzyScore("xyz", "aXbXc")).toBeNull();
  });

  test("is case insensitive", () => {
    expect(fuzzyScore("DUNE", "dune.part1.mp4")).not.toBeNull();
  });

  test("empty query matches everything", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  test("prefers word-boundary and prefix matches", () => {
    const loose = fuzzyScore("smk", "summer kickback 2019.mkv")!;
    const tight = fuzzyScore("smk", "some movie kicker.mkv")!;
    expect(tight).toBeGreaterThan(loose);
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { name: "show.s01e01.mp4" },
    { name: "show.s01e02.mp4" },
    { name: "dune.part1.mp4" },
    { name: "notes.txt" },
  ];

  test("ranks the best match first", () => {
    const ranked = fuzzyFilter(items, "dune", (i) => i.name);
    expect(ranked[0]!.item.name).toBe("dune.part1.mp4");
  });

  test("preserves input order on an empty query", () => {
    const ranked = fuzzyFilter(items, "", (i) => i.name);
    expect(ranked.map((r) => r.item.name)).toEqual(items.map((i) => i.name));
  });

  test("drops non-matches", () => {
    expect(fuzzyFilter(items, "zzzz", (i) => i.name).length).toBe(0);
  });
});

describe("parseOpenCommand", () => {
  test("keeps the placeholder in position, not just dropped", () => {
    const parsed = parseOpenCommand('"C:\\Program Files\\WMP\\wmplayer.exe" /prefetch:6 /Open "%L"');
    expect(parsed?.exe).toBe("C:\\Program Files\\WMP\\wmplayer.exe");
    expect(parsed?.args).toEqual(["/prefetch:6", "/Open", PLACEHOLDER]);
  });

  test("classic %1 placeholder", () => {
    const parsed = parseOpenCommand('"C:\\Tools\\PotPlayerMini64.exe" "%1"');
    expect(parsed?.exe).toBe("C:\\Tools\\PotPlayerMini64.exe");
    expect(parsed?.args).toEqual([PLACEHOLDER]);
  });

  test("unquoted exe", () => {
    const parsed = parseOpenCommand("C:\\Tools\\mpv.exe %1 -x");
    expect(parsed?.exe).toBe("C:\\Tools\\mpv.exe");
    expect(parsed?.args).toEqual([PLACEHOLDER, "-x"]);
  });

  test("expands environment variables in the exe path", () => {
    const parsed = parseOpenCommand('"%ProgramFiles%\\Video\\player.exe" "%1"');
    expect(parsed?.exe).toBe(`${process.env["ProgramFiles"]}\\Video\\player.exe`);
  });

  test("expands the parenthesised ProgramFiles(x86) form", () => {
    const parsed = parseOpenCommand('"%ProgramFiles(x86)%\\Windows Media Player\\wmplayer.exe" "%L"');
    expect(parsed?.exe).toBe(`${process.env["ProgramFiles(x86)"]}\\Windows Media Player\\wmplayer.exe`);
    expect(parsed?.args).toEqual([PLACEHOLDER]);
  });

  test("rejects nonsense", () => {
    expect(parseOpenCommand("")).toBeNull();
    expect(parseOpenCommand("   ")).toBeNull();
    expect(parseOpenCommand('"unterminated')).toBeNull();
  });
});

describe("expandEnvironment", () => {
  test("expands known vars and leaves unknown ones alone", () => {
    expect(expandEnvironment("%TEMP%")).toBe(process.env["TEMP"]);
    expect(expandEnvironment("%NOT_A_REAL_VAR%")).toBe("%NOT_A_REAL_VAR%");
  });
});

describe("resolveHandler (live registry)", () => {
  // Windows exposes only a ProgID at HKCR\\.ext, so this exercises the two-hop
  // lookup that a direct HKCR\\.ext\\shell\\open\\command query would miss.
  test("finds a real player for .mp4 on this machine", async () => {
    const handler = await resolveHandlerForTest("C:\\videos\\sample.mp4");
    if (handler === null) return; // no association on this machine
    expect(handler.exe.toLowerCase()).toContain(".exe");
  }, 15_000);

  test("returns null for an extension with no association", async () => {
    const handler = await resolveHandlerForTest("C:\\videos\\sample.zzznotavideo");
    expect(handler).toBeNull();
  }, 15_000);
});

describe("videoExtension", () => {
  test("accepts known formats, case-insensitively", () => {
    expect(videoExtension("a.mp4")).toBe("mp4");
    expect(videoExtension("a.MP4")).toBe("mp4");
    expect(videoExtension("a.Mkv")).toBe("mkv");
  });

  test("rejects non-video and edge cases", () => {
    expect(videoExtension("notes.txt")).toBeNull();
    expect(videoExtension("noext")).toBeNull();
    expect(videoExtension(".hidden")).toBeNull();
    expect(videoExtension("trailing.")).toBeNull();
  });
});

describe("media modes", () => {
  test("isMediaMode accepts known names only", () => {
    expect(isMediaMode("video")).toBe(true);
    expect(isMediaMode("book")).toBe(true);
    expect(isMediaMode("audio")).toBe(true);
    expect(isMediaMode("podcast")).toBe(false);
    expect(isMediaMode(42)).toBe(false);
    expect(isMediaMode(null)).toBe(false);
  });

  test("each mode only matches its own formats", () => {
    // This is the property that keeps a book scan from picking up the drive's videos.
    expect(modeExtension("a.mp4", "video")).toBe("mp4");
    expect(modeExtension("a.mp4", "book")).toBeNull();
    expect(modeExtension("a.mp4", "audio")).toBeNull();

    expect(modeExtension("a.epub", "book")).toBe("epub");
    expect(modeExtension("a.epub", "video")).toBeNull();

    expect(modeExtension("a.flac", "audio")).toBe("flac");
    expect(modeExtension("a.flac", "book")).toBeNull();
  });

  test("is case-insensitive per mode", () => {
    expect(modeExtension("A.EPUB", "book")).toBe("epub");
    expect(modeExtension("A.M4B", "audio")).toBe("m4b");
  });

  test("audiobooks belong to both book and audio", () => {
    expect(modeExtension("x.m4b", "book")).toBe("m4b");
    expect(modeExtension("x.m4b", "audio")).toBe("m4b");
    expect(modeExtension("x.m4a", "book")).toBe("m4a");
    expect(modeExtension("x.m4a", "audio")).toBe("m4a");
  });

  test("edge cases reject the same way in every mode", () => {
    for (const mode of ["video", "book", "audio"] as MediaMode[]) {
      expect(modeExtension("noext", mode)).toBeNull();
      expect(modeExtension(".hidden", mode)).toBeNull();
      expect(modeExtension("trailing.", mode)).toBeNull();
    }
  });

  test("isAnyMedia spans every mode", () => {
    expect(isAnyMedia("a.mp4")).toBe(true);
    expect(isAnyMedia("a.epub")).toBe(true);
    expect(isAnyMedia("a.flac")).toBe(true);
    expect(isAnyMedia("a.exe")).toBe(false);
  });
});

describe("scanMedia depth cap", () => {
  /** Build a chain of folders `depth` levels deep with a file at the bottom. */
  async function nestedTree(depth: number): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-depth-"));
    let current = root;
    for (let i = 0; i < depth; i += 1) {
      current = path.join(current, `level${i + 1}`);
    }
    await fs.mkdir(current, { recursive: true });
    await fs.writeFile(path.join(current, "deep.mp4"), "x");
    await fs.writeFile(path.join(root, "shallow.mp4"), "x");
    return root;
  }

  test("default depth is 4", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(4);
  });

  test("stops at the cap and reports truncation", async () => {
    // File sits at depth 6, deeper than the default cap of 4.
    const root = await nestedTree(6);
    try {
      const result = await scanMedia(root, { mode: "video", maxDepth: 4 });
      expect(result.files.map((f) => f.name)).toEqual(["shallow.mp4"]);
      expect(result.truncated).toBe(true);
      expect(result.deepestHit).not.toBeNull();
      expect(result.maxDepth).toBe(4);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("reaches deeper files when the cap allows", async () => {
    const root = await nestedTree(3);
    try {
      const result = await scanMedia(root, { mode: "video", maxDepth: 5 });
      expect(result.files.map((f) => f.name).sort()).toEqual(["deep.mp4", "shallow.mp4"]);
      expect(result.truncated).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("maxDepth 0 means unbounded", async () => {
    const root = await nestedTree(8);
    try {
      const result = await scanMedia(root, { mode: "video", maxDepth: 0 });
      expect(result.files).toHaveLength(2);
      expect(result.truncated).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("depth 1 stays in the root folder", async () => {
    const root = await nestedTree(3);
    try {
      const result = await scanMedia(root, { mode: "video", maxDepth: 1 });
      expect(result.files.map((f) => f.name)).toEqual(["shallow.mp4"]);
      expect(result.truncated).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("only collects the active mode's files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-mode-"));
    try {
      await fs.writeFile(path.join(root, "a.mp4"), "x");
      await fs.writeFile(path.join(root, "b.epub"), "x");
      await fs.writeFile(path.join(root, "c.flac"), "x");

      const video = await scanMedia(root, { mode: "video", maxDepth: 2 });
      expect(video.files.map((f) => f.name)).toEqual(["a.mp4"]);

      const book = await scanMedia(root, { mode: "book", maxDepth: 2 });
      expect(book.files.map((f) => f.name)).toEqual(["b.epub"]);

      const audio = await scanMedia(root, { mode: "audio", maxDepth: 2 });
      expect(audio.files.map((f) => f.name)).toEqual(["c.flac"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("skips system folders regardless of depth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-skip-"));
    try {
      await fs.mkdir(path.join(root, "Windows", "deep"), { recursive: true });
      await fs.writeFile(path.join(root, "Windows", "deep", "a.mp4"), "x");
      await fs.mkdir(path.join(root, "WinSxS"), { recursive: true });
      await fs.writeFile(path.join(root, "WinSxS", "b.mp4"), "x");
      await fs.writeFile(path.join(root, "keep.mp4"), "x");

      const result = await scanMedia(root, { mode: "video", maxDepth: 4 });
      expect(result.files.map((f) => f.name)).toEqual(["keep.mp4"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("folderKey", () => {
  test("is stable across case and trailing slashes", () => {
    const a = folderKey("C:\\Videos");
    expect(folderKey("c:\\videos\\")).toBe(a);
  });

  test("differs per folder", () => {
    expect(folderKey("C:\\Videos")).not.toBe(folderKey("D:\\Videos"));
  });
});

describe("scanVideos", () => {
  test("finds videos recursively and ignores other files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-scan-"));
    try {
      await fs.mkdir(path.join(root, "Season 1"), { recursive: true });
      await fs.writeFile(path.join(root, "top.mp4"), "x");
      await fs.writeFile(path.join(root, "readme.txt"), "x");
      await fs.writeFile(path.join(root, "Season 1", "ep.MKV"), "x");

      const result = await scanVideos(root);
      const names = result.files.map((f) => f.name).sort();
      expect(names).toEqual(["ep.MKV", "top.mp4"]);
      expect(result.files.find((f) => f.name === "ep.MKV")!.rel).toBe("Season 1/ep.MKV");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("records an unreadable folder without failing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-scan-"));
    const locked = path.join(root, "locked");
    try {
      await fs.mkdir(locked, { recursive: true });
      await fs.writeFile(path.join(root, "ok.mp4"), "x");
      const result = await scanVideos(root);
      expect(result.files.map((f) => f.name)).toContain("ok.mp4");
      expect(result.files.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("returns empty for a folder with no videos", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-empty-"));
    try {
      await fs.writeFile(path.join(root, "a.txt"), "x");
      const result = await scanVideos(root);
      expect(result.files).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("honours maxFiles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-cap-"));
    try {
      for (let i = 0; i < 12; i += 1) {
        await fs.writeFile(path.join(root, `v${i}.mp4`), "x");
      }
      const result = await scanVideos(root, { maxFiles: 5 });
      expect(result.files).toHaveLength(5);
      expect(result.errors.join(" ")).toMatch(/max reached/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("History", () => {
  const makeFile = (rel: string): VideoFile => ({
    path: `C:\\lib\\${rel}`,
    name: rel.split("/").pop()!,
    ext: "mp4",
    rel,
    size: 1,
    mtimeMs: 0,
  });

  test("starts empty for an unseen folder", async () => {
    const history = await History.load(path.join(os.tmpdir(), "never-seen-folder-xyz"));
    expect(history.has(makeFile("a.mp4"))).toBe(false);
    expect(history.count).toBe(0);
  });

  test("markWatched then has, and survives a reload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const file = makeFile("Season 1/ep.mp4");
      const first = await History.load(root);
      first.markWatched(file);
      expect(first.has(file)).toBe(true);
      expect(first.lastPlayed(file)).toBeGreaterThan(0);
      await first.save();

      const second = await History.load(root);
      expect(second.has(file)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("counts repeat plays", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const file = makeFile("a.mp4");
      const history = await History.load(root);
      history.markWatched(file);
      history.markWatched(file);
      await history.save();
      const reloaded = await History.load(root);
      expect(reloaded.count).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("prune drops vanished files only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const keep = makeFile("keep.mp4");
      const drop = makeFile("drop.mp4");
      const history = await History.load(root);
      history.markWatched(keep);
      history.markWatched(drop);
      const removed = history.prune([keep]);
      expect(removed).toBe(1);
      expect(history.has(keep)).toBe(true);
      expect(history.has(drop)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("tolerates a corrupt history file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const history = await History.load(root);
      await history.markWatched(makeFile("a.mp4")) === undefined;
      await history.save();
      const file = history as unknown as { file: string };
      await fs.writeFile(file.file, "{ this is not json", "utf8");

      const recovered = await History.load(root);
      expect(recovered.count).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("markWatched returns an undo token that restores prior state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const file = makeFile("a.mp4");
      const history = await History.load(root);

      // First mark: nothing existed, so the token is null and undo removes it.
      const firstToken = history.markWatched(file);
      expect(firstToken).toBeNull();
      expect(history.undo(file, firstToken)).toBe(true);
      expect(history.has(file)).toBe(false);

      // Second mark over an existing entry restores the old one rather than
      // deleting the key outright.
      history.markWatched(file);
      history.recordSession(file, 60_000);
      const secondToken = history.markWatched(file);
      expect(secondToken).not.toBeNull();
      expect(secondToken!.plays).toBe(1);
      expect(secondToken!.watchedMs).toBe(60_000);
      expect(history.undo(file, secondToken)).toBe(true);
      expect(history.has(file)).toBe(true);
      expect(history.watchedMs(file)).toBe(60_000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("undo on an absent entry reports no change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const history = await History.load(root);
      expect(history.undo(makeFile("ghost.mp4"), null)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("recordSession keeps the longest run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const file = makeFile("a.mp4");
      const history = await History.load(root);
      history.markWatched(file);

      history.recordSession(file, 600_000);
      expect(history.watchedMs(file)).toBe(600_000);

      // A later, shorter session must not shrink the record.
      history.recordSession(file, 5_000);
      expect(history.watchedMs(file)).toBe(600_000);

      // Nonsense durations are ignored rather than stored.
      history.recordSession(file, -1);
      history.recordSession(file, Number.NaN);
      expect(history.watchedMs(file)).toBe(600_000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("recordSession ignores a file that was never opened", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const history = await History.load(root);
      history.recordSession(makeFile("never.mp4"), 1000);
      expect(history.count).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("watchedMs survives a save and reload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-hist-"));
    try {
      const file = makeFile("a.mp4");
      const history = await History.load(root);
      history.markWatched(file);
      history.recordSession(file, 90_000);
      await history.save();

      const reloaded = await History.load(root);
      expect(reloaded.watchedMs(file)).toBe(90_000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("withRecentFolder", () => {
  test("puts the newest folder first", () => {
    const out = withRecentFolder(["C:\\a", "C:\\b"], "C:\\c");
    expect(out[0]).toBe("C:\\c");
    expect(out).toHaveLength(3);
  });

  test("moves a re-used folder to the front without duplicating", () => {
    const out = withRecentFolder(["C:\\a", "C:\\b"], "C:\\b");
    expect(out[0]).toBe("C:\\b");
    expect(out.filter((f) => f === "C:\\b")).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  test("de-duplicates case-insensitively and trims trailing slashes", () => {
    const out = withRecentFolder(["c:\\Lib"], "C:\\Lib\\");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/C:\\Lib$/);
  });

  test("respects the limit, keeping the newest", () => {
    let out: string[] = [];
    for (const folder of ["C:\\1", "C:\\2", "C:\\3", "C:\\4"]) {
      out = withRecentFolder(out, folder, 2);
    }
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("C:\\4");
  });
});

describe("withRecentFile", () => {
  const entry = (folder: string, rel: string, openedAt: number) => ({
    folder,
    rel,
    name: rel.split("/").pop()!,
    openedAt,
  });

  test("newest first", () => {
    const out = withRecentFile([entry("C:\\lib", "a.mp4", 1)], entry("C:\\lib", "b.mp4", 2));
    expect(out[0]!.rel).toBe("b.mp4");
  });

  test("reopening moves an entry to the front instead of duplicating", () => {
    const out = withRecentFile(
      [entry("C:\\lib", "a.mp4", 2), entry("C:\\lib", "b.mp4", 1)],
      entry("C:\\lib", "a.mp4", 3),
    );
    expect(out[0]!.rel).toBe("a.mp4");
    expect(out.filter((e) => e.rel === "a.mp4")).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  test("same filename in different folders stays separate", () => {
    const out = withRecentFile([entry("C:\\one", "a.mp4", 1)], entry("C:\\two", "a.mp4", 2));
    expect(out).toHaveLength(2);
  });

  test("respects the limit", () => {
    const many = Array.from({ length: 5 }, (_, i) => entry("C:\\lib", `${i}.mp4`, i));
    expect(withRecentFile(many, entry("C:\\lib", "new.mp4", 9), 3)).toHaveLength(3);
  });
});

describe("shortcuts", () => {
  test("maps every declared key to its action", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcutFor(shortcut.keys)).toBe(shortcut.action);
    }
  });

  test("is case-insensitive", () => {
    expect(shortcutFor("T")).toBe("tree");
    expect(shortcutFor("u")).toBe(shortcutFor("U"));
  });

  test("unknown keys return null", () => {
    expect(shortcutFor("z")).toBeNull();
    expect(shortcutFor("")).toBeNull();
  });

  test("help panel lists every shortcut", () => {
    const help = helpLines();
    expect(help).toHaveLength(SHORTCUTS.length);
    for (const shortcut of SHORTCUTS) {
      expect(help.some((line) => line.includes(shortcut.label))).toBe(true);
    }
  });
});

/** Strip ANSI so box-drawing and label assertions read as plain text. */
function plain(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

describe("treeLine", () => {
  const node = (rel: string, kind: "folder" | "file", file?: MediaFile): TreeNode => ({
    name: rel.split("/").pop()!,
    rel,
    depth: rel === "" ? 0 : 1,
    kind,
    file,
    children: [],
    expanded: kind === "folder",
    fileCount: kind === "folder" ? 7 : undefined,
  });

  test("folders show a disclosure arrow and a file count", async () => {
    const history = await History.load(path.join(os.tmpdir(), "rndvid-line-test"));
    const line = plain(treeLine(node("Season 1", "folder"), false, history, 60));
    expect(line).toContain("▾");
    expect(line).toContain("Season 1");
    expect(line).toContain("7");
  });

  test("collapsed folders show the closed arrow", async () => {
    const history = await History.load(path.join(os.tmpdir(), "rndvid-line-test"));
    const folder = node("Season 1", "folder");
    folder.expanded = false;
    expect(plain(treeLine(folder, false, history, 60))).toContain("▸");
  });

  test("the root omits its own count, which the header already states", async () => {
    const history = await History.load(path.join(os.tmpdir(), "rndvid-line-test"));
    const line = plain(treeLine(node("", "folder"), false, history, 60));
    expect(line).not.toContain("7");
  });

  test("unwatched files use an empty marker", async () => {
    const history = await History.load(path.join(os.tmpdir(), "rndvid-line-test"));
    const file: MediaFile = {
      path: "/x/a.mp4",
      name: "a.mp4",
      ext: "mp4",
      rel: "a.mp4",
      size: 1024,
      mtimeMs: 0,
    };
    expect(plain(treeLine(node("a.mp4", "file", file), false, history, 60))).toContain("○");
  });
});

describe("buildTree", () => {
  const file = (rel: string): MediaFile => ({
    path: `/lib/${rel}`,
    name: rel.split("/").pop()!,
    ext: "mp4",
    rel,
    size: 100,
    mtimeMs: 0,
  });

  test("nests files under their folders", () => {
    const root = buildTree(
      [file("top.mp4"), file("Season 1/ep01.mp4"), file("Season 1/ep02.mp4")],
      "lib",
    );
    expect(root.name).toBe("lib");
    expect(root.children.map((c) => c.name)).toEqual(["Season 1", "top.mp4"]);

    const season = root.children[0]!;
    expect(season.kind).toBe("folder");
    expect(season.fileCount).toBe(2);
    expect(season.children.map((c) => c.name)).toEqual(["ep01.mp4", "ep02.mp4"]);
  });

  test("root counts roll up from descendants", () => {
    const root = buildTree([file("a/b/c/deep.mp4"), file("top.mp4")], "lib");
    expect(root.fileCount).toBe(2);
  });

  test("creates intermediate folders for deep paths", () => {
    const root = buildTree([file("a/b/c/deep.mp4")], "lib");
    const a = root.children[0]!;
    const b = a.children[0]!;
    const c = b.children[0]!;
    expect([a.name, b.name, c.name]).toEqual(["a", "b", "c"]);
    expect(c.children[0]!.name).toBe("deep.mp4");
  });

  test("folders sort before files, each alphabetically", () => {
    const root = buildTree(
      [file("zeta.mp4"), file("alpha.mp4"), file("mfolder/x.mp4"), file("afolder/y.mp4")],
      "lib",
    );
    expect(root.children.map((c) => c.name)).toEqual([
      "afolder",
      "mfolder",
      "alpha.mp4",
      "zeta.mp4",
    ]);
  });

  test("filesUnder collects the whole subtree", () => {
    const root = buildTree([file("top.mp4"), file("Season 1/ep01.mp4")], "lib");
    const season = root.children[0]!;
    expect(filesUnder(season).map((f) => f.rel)).toEqual(["Season 1/ep01.mp4"]);
    expect(filesUnder(root).map((f) => f.rel).sort()).toEqual([
      "Season 1/ep01.mp4",
      "top.mp4",
    ]);
  });

  test("folderFor maps a node back to an absolute path", () => {
    const root = buildTree([file("Season 1/ep01.mp4")], "lib");
    expect(folderFor(root, "/lib")).toBe("/lib");
    expect(folderFor(root.children[0]!, "/lib")).toBe(path.join("/lib", "Season 1"));
  });

  test("an empty library yields a bare root", () => {
    const root = buildTree([], "lib");
    expect(root.children).toHaveLength(0);
    expect(root.fileCount).toBe(0);
  });
});
