import { spawn } from "node:child_process";
import fs from "node:fs/promises";

interface Handler {
  exe: string;
  /**
   * Args in order, with the file placeholder left as PLACEHOLDER so it can be
   * substituted in place — some associations put it mid-args rather than last.
   */
  args: string[];
}

export interface OpenResult {
  /** True when we tracked the player process and waited for it to exit. */
  waited: boolean;
  ok: boolean;
  /** How the file was opened, for logging. */
  via?: "direct" | "shell";
  error?: string;
}

const PLACEHOLDER = "\u0000FILE\u0000";

const handlerCache = new Map<string, Handler | null>();

/**
 * Open a file with whatever app Windows associates with it.
 *
 * When `wait` is set we resolve the association and spawn the real executable
 * directly, because that child handle can be awaited. `cmd /c start` hands off to
 * the shell and returns immediately, which would make "wait for the player"
 * meaningless — so it's only the fallback for when the association can't be
 * resolved.
 */
export async function openInDefaultPlayer(
  filePath: string,
  opts: { wait: boolean },
): Promise<OpenResult> {
  if (opts.wait) {
    const handler = await resolveHandler(filePath);
    if (handler) {
      const args = handler.args.map((arg) => (arg === PLACEHOLDER ? filePath : arg));
      // No placeholder in the command: append, which is the sane default.
      if (!handler.args.includes(PLACEHOLDER)) args.push(filePath);

      const result = await run(handler.exe, args);
      if (result.ok) return { ...result, via: "direct" };
      // Handler exe failed to launch: fall through to the shell-based path.
    }
  }

  // `start` needs an empty title arg, or it treats the file path as the window title.
  const shell = await run("cmd", ["/c", "start", "", filePath]);
  return { ...shell, via: "shell" };
}

function run(
  command: string,
  args: string[],
): Promise<{ waited: boolean; ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: "ignore",
        windowsHide: false,
        detached: false,
      });
    } catch (err) {
      resolve({ waited: false, ok: false, error: (err as Error).message });
      return;
    }

    let settled = false;
    const done = (result: { waited: boolean; ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once("error", (err) => done({ waited: false, ok: false, error: err.message }));
    child.once("exit", (code) =>
      done(
        code === 0
          ? { waited: true, ok: true }
          : { waited: true, ok: false, error: `exited with code ${code}` },
      ),
    );
  });
}

async function resolveHandler(filePath: string): Promise<Handler | null> {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  if (handlerCache.has(ext)) return handlerCache.get(ext)!;

  const handler = await probeRegistry(ext);
  handlerCache.set(ext, handler);
  return handler;
}

/**
 * Resolve the player for an extension.
 *
 * Two hops are required: `HKCR\.ext` holds only a ProgID, and the launch command
 * lives under that ProgID. Querying `HKCR\.ext\shell\open\command` directly fails
 * on a normal Windows install.
 */
async function probeRegistry(ext: string): Promise<Handler | null> {
  const progId = await regQueryDefaultValue(`HKCR\\${ext}`);
  if (!progId || progId.includes("\\")) return null;

  const command = await regQueryDefaultValue(`HKCR\\${progId}\\shell\\open\\command`);
  if (!command) return null;

  const handler = parseOpenCommand(command);
  if (!handler) return null;

  // A ProgID can also delegate via shell\open\DelegateExecute, which holds a
  // CLSID rather than a command. Those need COM, so treat them as unresolvable
  // and let the shell fallback handle it.
  if (!(await isExecutable(handler.exe))) return null;
  return handler;
}

/**
 * Read a key's default value. Handles REG_EXPAND_SZ, which stores unexpanded
 * tokens like `%ProgramFiles(x86)%` and must be resolved before the path is
 * usable.
 */
async function regQueryDefaultValue(key: string): Promise<string | null> {
  const raw = await regQuery(key);
  if (!raw) return null;
  return expandEnvironment(raw.trim());
}

function regQuery(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("reg", ["query", key, "/ve"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }

    let out = "";
    // reg.exe emits the console codepage; latin1 round-trips ASCII safely and we
    // only need ASCII to locate the value on the line.
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("latin1");
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      // Output is "(Default)    REG_SZ    <value>" — value runs to end of line.
      const match = /^\s*\(Default\)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(out);
      resolve(match ? match[1]!.trim() : null);
    });
  });
}

/** Expand `%VAR%` tokens, including the parenthesised `%ProgramFiles(x86)%` form. */
export function expandEnvironment(value: string): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const found = process.env[name];
    return found === undefined ? match : found;
  });
}

async function isExecutable(exe: string): Promise<boolean> {
  const expanded = expandEnvironment(exe);
  try {
    const st = await fs.stat(expanded);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Split a shell command into exe and args, keeping the file placeholder in
 * position.
 *
 * Handles both `%1` (classic) and `%L` (used by Windows Media Player), plus
 * `DropTarget`-free direct commands. Args are kept as raw tokens rather than
 * being re-joined, so a path with spaces stays a single argument.
 */
export function parseOpenCommand(command: string): Handler | null {
  let rest = expandEnvironment(command).trim();
  if (!rest) return null;

  let exe: string;
  if (rest.startsWith('"')) {
    const close = rest.indexOf('"', 1);
    if (close < 0) return null;
    exe = rest.slice(1, close);
    rest = rest.slice(close + 1).trim();
  } else {
    // Unquoted: the exe ends at the first .exe, since paths contain spaces.
    const match = /^(\S+\.exe)\s*/i.exec(rest);
    if (!match) return null;
    exe = match[1]!;
    rest = rest.slice(match[0].length).trim();
  }

  const args: string[] = [];
  for (const token of tokenize(rest)) {
    if (token === "%1" || token === "%L") args.push(PLACEHOLDER);
    else args.push(token);
  }
  return { exe, args };
}

/** Split a command tail into whitespace-separated tokens, respecting quotes. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;

  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

export { PLACEHOLDER };

/** Exposed for tests: resolve without launching anything. */
export async function resolveHandlerForTest(filePath: string): Promise<Handler | null> {
  return resolveHandler(filePath);
}
