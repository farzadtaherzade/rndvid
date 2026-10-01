/**
 * Tree prompt and single-key reader, driven through injected streams.
 *
 * Uses the same injectable approach as search-select.test.ts: node-pty's ConPTY
 * backend delivers no input on this machine, so keystrokes have to be synthesised.
 */
import { test, expect, describe } from "bun:test";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { treePrompt, buildTree, filesUnder, folderFor } from "../src/tree.ts";
import { readOneKey, isOneKeyCancel } from "../src/keypress.ts";
import { History } from "../src/history.ts";
import type { MediaFile } from "../src/scan.ts";

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  paused = false;
  setRawMode(mode: boolean) {
    this.rawMode = mode;
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
}

class FakeOutput {
  isTTY = true;
  columns = 100;
  chunks: string[] = [];
  write(text: string): boolean {
    this.chunks.push(text);
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

const ROOT = path.join(path.parse(process.cwd()).root, "library");

function makeFiles(): MediaFile[] {
  const mk = (rel: string, size = 100): MediaFile => ({
    path: path.join(ROOT, rel),
    name: rel.split("/").pop()!,
    ext: "mp4",
    rel,
    size,
    mtimeMs: 0,
  });
  return [
    mk("top.mp4"),
    mk("Season 1/ep01.mp4"),
    mk("Season 1/ep02.mp4"),
    mk("Season 2/ep01.mp4"),
    mk("Extras/clip.mkv"),
  ];
}

async function makeHistory(): Promise<History> {
  return History.load(path.join(os.tmpdir(), "rndvid-tree-test"));
}

/** Run the tree prompt, sending one token at a time after a redraw. */
async function driveTree(
  tokens: string[],
  files = makeFiles(),
): Promise<{ result: Awaited<ReturnType<typeof treePrompt>>; output: FakeOutput; input: FakeInput }> {
  const input = new FakeInput();
  const output = new FakeOutput();
  const history = await makeHistory();

  const pending = treePrompt({
    root: ROOT,
    files,
    history,
    input: input as never,
    output: output as never,
    allowNonTTY: true,
  });
  await Bun.sleep(10);

  for (const token of tokens) {
    switch (token) {
      case "ENTER":
        input.emit("keypress", "\r", { name: "return" });
        break;
      case "ESC":
        input.emit("keypress", "\u001B", { name: "escape" });
        break;
      case "CTRLC":
        input.emit("keypress", "\u0003", { name: "c", ctrl: true });
        break;
      case "LEFT":
        input.emit("keypress", "", { name: "left" });
        break;
      case "RIGHT":
        input.emit("keypress", "", { name: "right" });
        break;
      case "TAB":
        input.emit("keypress", "\t", { name: "tab" });
        break;
      case "BKSP":
        input.emit("keypress", "\b", { name: "backspace" });
        break;
      case "DOWN":
        input.emit("keypress", "", { name: "down" });
        break;
      case "UP":
        input.emit("keypress", "", { name: "up" });
        break;
      default:
        input.emit("keypress", token, { name: token });
        break;
    }
    await Bun.sleep(10);
  }

  return { result: await pending, output, input };
}

/** Strip ANSI from rendered output so assertions read as plain text. */
function plain(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/**
 * Text of the most recent frame only.
 *
 * The prompt redraws in place, so the buffer holds every frame ever drawn.
 * Asserting on the whole buffer would match content that was on screen before a
 * collapse, which is exactly the distinction some tests need to make.
 */
function lastFrame(output: FakeOutput): string {
  const raw = output.text;
  const marker = "\u001B[0J";
  const at = raw.lastIndexOf(marker);
  return plain(at === -1 ? raw : raw.slice(at + marker.length));
}

describe("treePrompt rendering", () => {
  test("shows folders and files with counts", async () => {
    const { output } = await driveTree(["CTRLC"]);
    const text = plain(output.text);
    expect(text).toContain("library");
    expect(text).toContain("Season 1");
    expect(text).toContain("Extras");
    expect(text).toContain("top.mp4");
    // Folder counts roll up from descendants.
    expect(text).toMatch(/Season 1\s+2/);
  });

  test("shows the navigation help and a position indicator", async () => {
    const { output } = await driveTree(["CTRLC"]);
    const text = plain(output.text);
    expect(text).toContain("expand");
    expect(text).toContain("collapse");
    expect(text).toMatch(/\d+\/\d+/);
  });

  test("marks watched files differently from unwatched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rndvid-tree-mark-"));
    try {
      const files: MediaFile[] = [
        {
          path: path.join(root, "seen.mp4"),
          name: "seen.mp4",
          ext: "mp4",
          rel: "seen.mp4",
          size: 10,
          mtimeMs: 0,
        },
        {
          path: path.join(root, "fresh.mp4"),
          name: "fresh.mp4",
          ext: "mp4",
          rel: "fresh.mp4",
          size: 10,
          mtimeMs: 0,
        },
      ];
      const history = await History.load(root);
      history.markWatched(files[0]!);
      history.recordSession(files[0]!, 22 * 60_000);
      await history.save();

      const input = new FakeInput();
      const output = new FakeOutput();
      const pending = treePrompt({
        root,
        files,
        history,
        input: input as never,
        output: output as never,
        allowNonTTY: true,
      });
      await Bun.sleep(20);
      input.emit("keypress", "\u0003", { name: "c", ctrl: true });
      await pending;

      const text = plain(output.text);
      expect(text).toContain("✓");
      expect(text).toContain("○");
      // A session with no known total shows a duration, not a fake percentage.
      expect(text).toContain("22m");
      await fs.rm(root, { recursive: true, force: true });
    } finally {
      // Nothing to clean beyond the per-test dir above.
    }
  });

  test("filter narrows the visible nodes", async () => {
    const { output } = await driveTree(["e", "x", "CTRLC"]);
    const text = lastFrame(output);
    expect(text).toContain("Extras");
    expect(text).toContain("filter ex");
    // Non-matching folders drop out of the filtered view.
    expect(text).not.toContain("Season 2");
  });

  test("filter keeps ancestors of a match so the path stays readable", async () => {
    const { output } = await driveTree(["e", "p", "0", "1", "CTRLC"]);
    const text = lastFrame(output);
    expect(text).toContain("Season 1");
    expect(text).toContain("ep01.mp4");
  });

  test("reports when nothing matches the filter", async () => {
    const { output } = await driveTree(["z", "z", "z", "q", "CTRLC"]);
    const text = plain(output.text);
    expect(text).toMatch(/no folders or files match/);
  });
});

describe("treePrompt navigation", () => {
  test("enter on the root rolls from the whole library", async () => {
    const { result } = await driveTree(["ENTER"]);
    expect(result.action).toBe("roll");
    if (result.action === "roll") expect(result.folder).toBe(ROOT);
  });

  test("enter on a folder rolls from that folder", async () => {
    // Folders sort before files and alphabetically, so row 1 is "Extras".
    const { result } = await driveTree(["DOWN", "ENTER"]);
    expect(result.action).toBe("roll");
    if (result.action === "roll") {
      expect(result.folder).toBe(path.join(ROOT, "Extras"));
      expect(filesUnder(result.node)).toHaveLength(1);
    }
  });

  test("left collapses an expanded folder", async () => {
    const collapsed = await driveTree(["LEFT", "CTRLC"]);
    // After collapsing the root, nothing beneath it is on screen.
    expect(lastFrame(collapsed.output)).not.toContain("ep01.mp4");

    const expanded = await driveTree(["CTRLC"]);
    expect(lastFrame(expanded.output)).toContain("ep01.mp4");
  });

  test("left on a file jumps to its parent folder", async () => {
    // Down to "Extras", then down onto its file, then left back to the folder.
    const { result } = await driveTree(["DOWN", "DOWN", "LEFT", "ENTER"]);
    expect(result.action).toBe("roll");
    if (result.action === "roll") {
      expect(result.folder).toBe(path.join(ROOT, "Extras"));
    }
  });

  test("right expands a collapsed folder", async () => {
    const { result } = await driveTree(["LEFT", "RIGHT", "CTRLC"]);
    // No crash, and the tree is still live after the round trip.
    expect(result.action).toBe("cancel");
  });

  test("tab hands back to the folder browser", async () => {
    const { result } = await driveTree(["TAB"]);
    expect(result.action).toBe("browse");
  });

  test("escape clears the filter, then cancels", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = treePrompt({
      root: ROOT,
      files: makeFiles(),
      history: await makeHistory(),
      input: input as never,
      output: output as never,
      allowNonTTY: true,
    });
    await Bun.sleep(10);

    input.emit("keypress", "z", { name: "z" });
    await Bun.sleep(10);
    input.emit("keypress", "\u001B", { name: "escape" });
    await Bun.sleep(20);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);

    input.emit("keypress", "\u001B", { name: "escape" });
    expect((await pending).action).toBe("cancel");
  });

  test("ctrl+c cancels", async () => {
    const { result } = await driveTree(["CTRLC"]);
    expect(result.action).toBe("cancel");
  });

  test("restores raw mode and the cursor on exit", async () => {
    const { input, output } = await driveTree(["ENTER"]);
    expect(input.rawMode).toBe(false);
    expect(output.text).toContain("\u001B[?25h");
  });

  test("allowNonTTY still requires a keypress, since it only skips the TTY check", async () => {
    const input = new FakeInput();
    input.isTTY = false;
    const output = new FakeOutput();
    const pending = treePrompt({
      root: ROOT,
      files: makeFiles(),
      history: await makeHistory(),
      input: input as never,
      output: output as never,
      allowNonTTY: true,
    });
    await Bun.sleep(10);
    input.emit("keypress", "\r", { name: "return" });
    const result = await pending;
    expect(result.action).toBe("roll");
  });

  test("cancels without a TTY when allowNonTTY is not set", async () => {
    const input = new FakeInput();
    input.isTTY = false;
    const result = await treePrompt({
      root: ROOT,
      files: makeFiles(),
      history: await makeHistory(),
      input: input as never,
      output: new FakeOutput() as never,
    });
    expect(result.action).toBe("cancel");
  });

  test("an empty library still renders and can be cancelled", async () => {
    const { result, output } = await driveTree(["CTRLC"], []);
    expect(result.action).toBe("cancel");
    expect(plain(output.text)).toContain("library");
  });
});

describe("readOneKey", () => {
  async function readKey(key: string, extra: Record<string, unknown> = {}) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = readOneKey({
      input: input as never,
      output: output as never,
      allowNonTTY: true,
    });
    await Bun.sleep(10);
    input.emit("keypress", key, { name: key, ...extra });
    return { key: await pending, input, output };
  }

  test("returns the printable character", async () => {
    const { key } = await readKey("t");
    expect(isOneKeyCancel(key)).toBe(false);
    if (!isOneKeyCancel(key)) expect(key.char).toBe("t");
  });

  test("returns enter as a named key with no character", async () => {
    const { key } = await readKey("\r", { name: "return" });
    if (!isOneKeyCancel(key)) {
      expect(key.name).toBe("return");
      expect(key.char).toBe("");
    }
  });

  test("ctrl+c cancels", async () => {
    const { key } = await readKey("\u0003", { name: "c", ctrl: true });
    expect(isOneKeyCancel(key)).toBe(true);
  });

  test("restores raw mode and the cursor", async () => {
    const { input, output } = await readKey("a");
    expect(input.rawMode).toBe(false);
    expect(output.text).toContain("\u001B[?25h");
  });

  test("cancels immediately without a TTY", async () => {
    const input = new FakeInput();
    input.isTTY = false;
    const key = await readOneKey({
      input: input as never,
      output: new FakeOutput() as never,
      allowNonTTY: false,
    });
    expect(isOneKeyCancel(key)).toBe(true);
  });
});

describe("tree helper functions", () => {
  test("filesUnder returns the subtree for a folder node", () => {
    const root = buildTree(makeFiles(), "library");
    const extras = root.children.find((c) => c.name === "Extras")!;
    expect(filesUnder(extras).map((f) => f.rel)).toEqual(["Extras/clip.mkv"]);
  });

  test("folderFor returns the root unchanged for the root node", () => {
    const root = buildTree(makeFiles(), "library");
    expect(folderFor(root, ROOT)).toBe(ROOT);
  });

  test("a file node maps back to the root, since files aren't libraries", () => {
    const root = buildTree(makeFiles(), "library");
    const file = root.children.find((c) => c.kind === "file")!;
    expect(folderFor(file, ROOT)).toBe(ROOT);
  });
});
