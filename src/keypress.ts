import readline from "node:readline";

/**
 * Minimal single-keystroke reader.
 *
 * The existing prompts are clack's, which need Enter to confirm. That's fine for
 * a question but wrong for a shortcut bar, where the whole point is that `t` or
 * `u` acts immediately. This reads one keypress in raw mode and hands back the
 * character, leaving Enter free to mean "the default".
 *
 * Same raw-mode plumbing as the list prompt, kept here so the cleanup rules
 * (restore raw mode, show cursor, pause stdin) live in one place.
 */
export interface OneKeyOptions {
  input?: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  output?: NodeJS.WriteStream;
  allowNonTTY?: boolean;
}

export interface OneKey {
  /** The printable character, or "" for named keys like arrows and escape. */
  char: string;
  name?: string;
  ctrl?: boolean;
}

export const CANCEL = Symbol.for("rndvid.cancel");

export function isOneKeyCancel(value: unknown): value is typeof CANCEL {
  return typeof value === "symbol" && value === CANCEL;
}

export function readOneKey(options: OneKeyOptions = {}): Promise<OneKey | typeof CANCEL> {
  const input = options.input ?? (process.stdin as OneKeyOptions["input"]);
  const output = options.output ?? process.stdout;
  const interactive = Boolean(input?.isTTY && output.isTTY);

  if (!interactive && options.allowNonTTY !== true) {
    return Promise.resolve(CANCEL);
  }
  if (!input) return Promise.resolve(CANCEL);

  return new Promise<OneKey | typeof CANCEL>((resolve) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      if (input.setRawMode && input.isTTY) input.setRawMode(false);
      output.write("\u001B[?25h");
      input.pause?.();
    };

    function onKeypress(str: string | undefined, key: readline.Key): void {
      cleanup();
      if (key.ctrl && key.name === "c") {
        resolve(CANCEL);
        return;
      }
      resolve({ char: typeof str === "string" && str >= " " ? str : "", ...key });
    }

    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    output.write("\u001B[?25l");
    input.on("keypress", onKeypress);
    input.resume?.();
  });
}
