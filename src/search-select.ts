import readline from "node:readline";

import { fuzzyFilter } from "./fuzzy.ts";
import { color, truncate } from "./ui.ts";

export interface SearchOption<V> {
  value: V;
  label: string;
  hint?: string;
}

export interface SearchSelectOptions<V> {
  message: string;
  options: SearchOption<V>[];
  /** Rows of results visible at once. */
  maxVisible?: number;
  emptyMessage?: string;
  initialQuery?: string;
  /** Option to highlight before any filtering; not auto-selected. */
  initialValue?: V;
  /**
   * Streams to drive, defaulting to the real terminal. Injectable so the prompt
   * can be tested without a TTY, which the key handling and redraw logic
   * otherwise can't reach in CI.
   */
  input?: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  output?: NodeJS.WriteStream;
  /** Overrides the interactive-terminal requirement. For tests. */
  allowNonTTY?: boolean;
}

const CANCEL = Symbol.for("rndvid.cancel");

/**
 * Filterable list prompt with arrow-key navigation.
 *
 * Written by hand because @clack/prompts' `select` takes a static option array
 * with no type-ahead filtering (verified against both 0.11 and 1.8), and
 * searching thousands of filenames is the whole point here. Clack's text and
 * confirm prompts are used elsewhere; this exists only where clack can't follow.
 *
 * Resolves the selected value, or `CANCEL` on Ctrl+C / Escape / stream end.
 */
export function searchSelect<V>(opts: SearchSelectOptions<V>): Promise<V | typeof CANCEL> {
  const maxVisible = opts.maxVisible ?? 10;

  return new Promise<V | typeof CANCEL>((resolve) => {
    const input = opts.input ?? (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void });
    const output = opts.output ?? process.stdout;
    const interactive = Boolean(input.isTTY && output.isTTY);

    if (!interactive && opts.allowNonTTY !== true) {
      // Nothing to drive the prompt with, so fail loudly rather than hanging.
      process.stderr.write("searchSelect requires an interactive terminal.\n");
      resolve(CANCEL);
      return;
    }

    let query = opts.initialQuery ?? "";
    let cursor = 0;
    let renderedLines = 0;
    let settled = false;

    // Highlight a requested option without consuming it, so Enter still submits
    // whatever is under the cursor.
    if (opts.initialValue !== undefined) {
      const index = opts.options.findIndex((o) => o.value === opts.initialValue);
      if (index >= 0) cursor = index;
    }

    const ranked = () => fuzzyFilter(opts.options, query, (o) => `${o.label} ${o.hint ?? ""}`);

    const render = () => {
      const width = output.columns ?? 80;
      const results = ranked();
      if (results.length === 0) cursor = 0;
      else if (cursor >= results.length) cursor = results.length - 1;
      else if (cursor < 0) cursor = 0;

      // Keep the cursor inside the visible window.
      let start = 0;
      if (cursor >= maxVisible) start = cursor - maxVisible + 1;

      const lines: string[] = [];
      lines.push(`${color.gray("◆")}  ${truncate(opts.message, width - 4)}`);

      const shownQuery = query === "" ? color.gray("type to search…") : query;
      lines.push(`${color.gray("│")}  ${color.dim("search: ")}${truncate(shownQuery, Math.max(4, width - 14))}`);

      if (results.length === 0) {
        lines.push(`${color.gray("│")}`);
        lines.push(`   ${color.yellow(opts.emptyMessage ?? "no matches")}`);
      } else {
        for (let k = 0; k < maxVisible && start + k < results.length; k += 1) {
          const entry = results[start + k]!;
          const option = entry.item;
          const active = start + k === cursor;
          const marker = active ? color.cyan("❯") : " ";
          const label = active ? color.cyan(option.label) : option.label;
          const hint = option.hint ? `  ${color.dim(option.hint)}` : "";
          lines.push(`${color.gray("│")}  ${marker} ${truncate(label + hint, width - 6)}`);
        }
      }

      lines.push(`${color.gray("│")}`);
      const position = results.length > 0 ? `${cursor + 1}/${results.length}` : "0/0";
      lines.push(
        `${color.gray("└")}  ${color.dim("↑↓ move · enter select · esc clear/cancel")}  ${color.dim(position)}`,
      );

      let out = "";
      if (renderedLines > 0) {
        // The trailing newline left us one line below the block, so step up the
        // full block height before clearing.
        out += `\u001B[${renderedLines}A\u001B[0J`;
      }
      out += `${lines.join("\n")}\n`;
      renderedLines = lines.length;
      output.write(out);
    };

    const cleanup = () => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGWINCH", onResize);
      input.removeListener("keypress", onKeypress);
      if (input.setRawMode && input.isTTY) input.setRawMode(false);
      output.write("\u001B[?25h"); // restore cursor
      if (typeof input.pause === "function") input.pause();
    };

    const finish = (value: V | typeof CANCEL) => {
      if (settled) return;
      // Leave the final selection on screen, the way clack's prompts do.
      cleanup();
      resolve(value);
    };

    function onResize() {
      render();
    }

    function onKeypress(_str: string | undefined, key: readline.Key): void {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        resolve(CANCEL);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const results = ranked();
        if (results.length > 0) {
          const chosen = results[cursor]!.item;
          // Replace the live block with a single confirmed line.
          output.write(`\u001B[${renderedLines}A\u001B[0J`);
          output.write(
            `${color.gray("◆")}  ${opts.message} ${color.cyan(truncate(chosen.label, 70))}\n`,
          );
          finish(chosen.value);
        }
        return;
      }

      if (key.name === "escape") {
        // First Escape clears a query, a second cancels. Losing a long query to
        // one stray keypress is annoying.
        if (query !== "") {
          query = "";
          cursor = 0;
          render();
          return;
        }
        cleanup();
        output.write("\n");
        resolve(CANCEL);
        return;
      }

      if (key.name === "backspace") {
        query = query.slice(0, -1);
        cursor = 0;
        render();
        return;
      }

      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        cursor -= 1;
        render();
        return;
      }

      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        cursor += 1;
        render();
        return;
      }

      if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
        render();
        return;
      }

      if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = Number.MAX_SAFE_INTEGER;
        render();
        return;
      }

      if (key.name === "pageup") {
        cursor = Math.max(0, cursor - maxVisible);
        render();
        return;
      }

      if (key.name === "pagedown") {
        cursor += maxVisible;
        render();
        return;
      }

      // Printable input. `str` is the raw sequence, so only take it when the key
      // is a plain character (name === the character itself).
      if (key.ctrl || key.meta || key.name === "tab") return;
      if (typeof _str === "string" && _str.length > 0 && _str >= " ") {
        query += _str;
        cursor = 0;
        render();
      }
    }

    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    output.write("\u001B[?25l"); // hide cursor while typing
    if (interactive) process.on("SIGWINCH", onResize);
    input.on("keypress", onKeypress);
    input.resume?.();
    render();
  });
}

export function isSearchCancel(value: unknown): value is typeof CANCEL {
  return typeof value === "symbol" && (value as symbol) === CANCEL;
}

export { CANCEL };
