/**
 * Drives searchSelect through fake streams, since the key handling and redraw
 * logic need a TTY that CI doesn't have.
 */
import { test, expect, describe } from "bun:test";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import { searchSelect, isSearchCancel, type SearchOption } from "../src/search-select.ts";

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
  columns = 80;
  chunks: string[] = [];
  write(text: string): boolean {
    this.chunks.push(text);
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

const OPTIONS: SearchOption<string>[] = [
  { value: "a", label: "alpha.mp4" },
  { value: "b", label: "bravo.mkv" },
  { value: "c", label: "charlie.avi" },
  { value: "d", label: "delta.mov" },
];

/**
 * Feed a key sequence and await the prompt's result.
 * Tokens: single letters, "ENTER", "ESC", "CTRLC", "DOWN", "UP", "BKSP", "SPACE".
 */
async function drive(
  tokens: string[],
  options: Partial<Parameters<typeof searchSelect>[0]> = {},
): Promise<{ result: unknown; output: FakeOutput; input: FakeInput }> {
  const input = new FakeInput();
  const output = new FakeOutput();

  const pending = searchSelect<string>({
    message: "Pick one",
    options: OPTIONS,
    input: input as never,
    output: output as never,
    allowNonTTY: true,
    ...options,
  });

  const settle = pending;
  // Let the initial render happen before sending keys.
  await Bun.sleep(10);

  for (const token of tokens) {
    switch (token) {
      case "ENTER":
        input.emit("keypress", "\r", { name: "return" } as readline.Key);
        break;
      case "ESC":
        input.emit("keypress", "\u001B", { name: "escape" } as readline.Key);
        break;
      case "CTRLC":
        input.emit("keypress", "\u0003", { name: "c", ctrl: true } as readline.Key);
        break;
      case "DOWN":
        input.emit("keypress", "", { name: "down" } as readline.Key);
        break;
      case "UP":
        input.emit("keypress", "", { name: "up" } as readline.Key);
        break;
      case "BKSP":
        input.emit("keypress", "\b", { name: "backspace" } as readline.Key);
        break;
      case "SPACE":
        input.emit("keypress", " ", { name: "space" } as readline.Key);
        break;
      default:
        input.emit("keypress", token, { name: token } as readline.Key);
        break;
    }
    await Bun.sleep(10);
  }

  const result = await settle;
  return { result, output, input };
}

describe("searchSelect", () => {
  test("returns the highlighted option on enter", async () => {
    const { result } = await drive(["ENTER"]);
    expect(result).toBe("a");
  });

  test("arrow keys move the cursor", async () => {
    const down = await drive(["DOWN", "ENTER"]);
    expect(down.result).toBe("b");

    const twice = await drive(["DOWN", "DOWN", "ENTER"]);
    expect(twice.result).toBe("c");

    const upFromTop = await drive(["UP", "ENTER"]);
    expect(upFromTop.result).toBe("a");
  });

  test("typing filters and ranks by match quality", async () => {
    const { result } = await drive(["c", "h", "a", "r", "ENTER"]);
    expect(result).toBe("c"); // charlie.avi is the only match
  });

  test("a broad query ranks the best match first", async () => {
    const { result } = await drive(["a", "ENTER"]);
    // "a" matches all four; the subsequence scorer should put alpha.mp4 on top.
    expect(result).toBe("a");
  });

  test("filter then backspace restores the full list", async () => {
    const typed = await drive(["c", "h", "a", "ENTER"]);
    expect(typed.result).toBe("c");

    const erased = await drive(["c", "h", "BKSP", "BKSP", "BKSP", "BKSP", "ENTER"]);
    expect(erased.result).toBe("a");
  });

  test("enter on no matches does nothing", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = searchSelect<string>({
      message: "Pick",
      options: OPTIONS,
      input: input as never,
      output: output as never,
      allowNonTTY: true,
    });
    await Bun.sleep(10);

    for (const ch of "zzzzz") {
      input.emit("keypress", ch, { name: ch } as readline.Key);
      await Bun.sleep(5);
    }
    input.emit("keypress", "\r", { name: "return" } as readline.Key);
    await Bun.sleep(30);

    // Still pending: no match means nothing was submitted.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);

    // Escape clears, then a second escape cancels.
    input.emit("keypress", "\u001B", { name: "escape" } as readline.Key);
    await Bun.sleep(10);
    input.emit("keypress", "\u001B", { name: "escape" } as readline.Key);
    expect(isSearchCancel(await pending)).toBe(true);
  });

  test("escape clears the query first, then cancels", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = searchSelect<string>({
      message: "Pick",
      options: OPTIONS,
      input: input as never,
      output: output as never,
      allowNonTTY: true,
    });
    await Bun.sleep(10);

    input.emit("keypress", "c", { name: "c" } as readline.Key);
    await Bun.sleep(10);
    // First escape clears the query, prompt stays open.
    input.emit("keypress", "\u001B", { name: "escape" } as readline.Key);
    await Bun.sleep(20);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);

    // Second escape cancels.
    input.emit("keypress", "\u001B", { name: "escape" } as readline.Key);
    const result = await pending;
    expect(isSearchCancel(result)).toBe(true);
  });

  test("ctrl+c cancels", async () => {
    const { result } = await drive(["CTRLC"]);
    expect(isSearchCancel(result)).toBe(true);
  });

  test("restores raw mode and shows the cursor on exit", async () => {
    const { input, output } = await drive(["ENTER"]);
    expect(input.rawMode).toBe(false);
    expect(output.text).toContain("\u001B[?25h");
  });

  test("redraws in place instead of scrolling", async () => {
    const { output } = await drive(["c", "h", "ENTER"]);
    // Every redraw after the first must move the cursor back up.
    expect(output.text).toContain("\u001B[");
    const redraws = output.text.split("\u001B[0J").length - 1;
    expect(redraws).toBeGreaterThan(2);
  });

  test("renders a hint and the empty-state message", async () => {
    const output = new FakeOutput();
    const input = new FakeInput();
    const pending = searchSelect<string>({
      message: "Pick",
      options: [{ value: "x", label: "only.mp4", hint: "12 MiB" }],
      emptyMessage: "nothing here",
      input: input as never,
      output: output as never,
      allowNonTTY: true,
    });
    await Bun.sleep(20);
    expect(output.text).toContain("12 MiB");

    input.emit("keypress", "\u0003", { name: "c", ctrl: true } as readline.Key);
    await pending;
  });

  test("respects maxVisible and scrolls the window", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      value: String(i),
      label: `file${String(i).padStart(2, "0")}.mp4`,
    }));
    const input = new FakeInput();
    const output = new FakeOutput();
    const pending = searchSelect<string>({
      message: "Pick",
      options: many,
      maxVisible: 4,
      input: input as never,
      output: output as never,
      allowNonTTY: true,
    });
    await Bun.sleep(20);
    const initial = output.text;
    expect(initial).toContain("file00.mp4");
    expect(initial).not.toContain("file08.mp4");

    // Move down past the window and confirm the tail scrolls in.
    for (let i = 0; i < 8; i += 1) {
      input.emit("keypress", "", { name: "down" } as readline.Key);
      await Bun.sleep(5);
    }
    const scrolled = output.text;
    expect(scrolled).toContain("file08.mp4");

    input.emit("keypress", "\r", { name: "return" } as readline.Key);
    expect(await pending).toBe("8");
  });
});
