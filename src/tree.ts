import path from "node:path";
import readline from "node:readline";

import type { MediaFile } from "./scan.ts";
import type { History } from "./history.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { color, formatBytes, formatDuration, truncate } from "./ui.ts";

/**
 * Collapsible tree of the scanned library.
 *
 * Built from the scan result rather than the filesystem, so it costs no extra
 * I/O and always matches what the picker would actually roll from.
 */
export interface TreeNode {
  name: string;
  /** Folder path relative to the scan root, posix separators. `""` at the root. */
  rel: string;
  depth: number;
  kind: "folder" | "file";
  file?: MediaFile;
  /** Files under this folder, for the `n files` hint. Only on folders. */
  fileCount?: number;
  children: TreeNode[];
  expanded: boolean;
}

const CANCEL = Symbol.for("rndvid.cancel");

/**
 * Group scan results into a folder tree.
 *
 * Intermediate folders are created even when the scan only saw files deep
 * inside them, so the hierarchy is never broken by the depth cap.
 */
export function buildTree(files: readonly MediaFile[], rootName: string): TreeNode {
  const root: TreeNode = {
    name: rootName,
    rel: "",
    depth: 0,
    kind: "folder",
    children: [],
    expanded: true,
  };

  for (const file of files) {
    const parts = file.rel.split("/");
    let node = root;
    let prefix = "";

    for (const part of parts.slice(0, -1)) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      let child = node.children.find((c) => c.kind === "folder" && c.name === part);
      if (!child) {
        child = {
          name: part,
          rel: prefix,
          depth: node.depth + 1,
          kind: "folder",
          children: [],
          expanded: false,
          fileCount: 0,
        };
        node.children.push(child);
      }
      node = child;
    }
    node.fileCount = (node.fileCount ?? 0) + 1;

    node.children.push({
      name: file.name,
      rel: file.rel,
      depth: node.depth + 1,
      kind: "file",
      file,
      children: [],
      expanded: false,
    });
  }

  sortTree(root);
  countUp(root);
  return root;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    // Folders first, then by name; files before folders go to the end.
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}

/** Roll the direct-file counts up so parents can show a total. */
function countUp(node: TreeNode): number {
  let total = node.kind === "file" ? 1 : 0;
  for (const child of node.children) total += countUp(child);
  if (node.kind === "folder") node.fileCount = total;
  return total;
}

/**
 * Depth-first list of visible nodes.
 *
 * Only folders can be collapsed, so the `expanded` gate applies to folders only —
 * checking it on files would hide every leaf. Children are appended exactly once:
 * recursing with `visibleNodes` would re-add each child as its own subtree root.
 */
function visibleNodes(root: TreeNode): TreeNode[] {
  // The node's own expanded flag gates its children, so collapsing the root hides
  // everything beneath it.
  if (!root.expanded) return [root];

  const out: TreeNode[] = [root];
  for (const child of root.children) {
    out.push(child);
    if (child.kind === "folder" && child.expanded) out.push(...descendants(child));
  }
  return out;
}

function descendants(node: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  for (const child of node.children) {
    if (child.kind === "folder" && !child.expanded) continue;
    out.push(child, ...descendants(child));
  }
  return out;
}

/** Every node in the tree, in document order, regardless of expansion. */
function allNodes(node: TreeNode): TreeNode[] {
  return [node, ...node.children.flatMap(allNodes)];
}

/** Nearest ancestor present in `universe`. */
function parentOf(node: TreeNode, universe: readonly TreeNode[]): TreeNode | undefined {
  if (node.rel === "") return undefined;
  const target = node.rel.split("/").slice(0, -1).join("/");
  return universe.find((candidate) => candidate.kind === "folder" && candidate.rel === target);
}

/** Flatten a node's subtree into files, for "roll everything under here". */
export function filesUnder(node: TreeNode): MediaFile[] {
  const out: MediaFile[] = [];
  if (node.file) out.push(node.file);
  for (const child of node.children) out.push(...filesUnder(child));
  return out;
}

/** The folder to treat as the new library when a folder node is chosen. */
export function folderFor(node: TreeNode, root: string): string {
  if (node.kind !== "folder") return root;
  return node.rel === "" ? root : path.join(root, node.rel);
}

export type TreeResult =
  | { action: "roll"; folder: string; node: TreeNode }
  | { action: "browse" }
  | { action: "cancel" };

export interface TreeOptions {
  root: string;
  files: readonly MediaFile[];
  history: History;
  /** Labels the tree, e.g. "library". */
  title?: string;
  maxVisible?: number;
  input?: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  output?: NodeJS.WriteStream;
  allowNonTTY?: boolean;
}

/**
 * Interactive tree prompt.
 *
 * Returns `roll` with the folder to use, `browse` to fall back to the folder
 * browser, or `cancel`. Keys: up/down move, right expands or descends, left
 * collapses or ascends, enter picks, `/` filters, esc clears then cancels.
 */
export function treePrompt(options: TreeOptions): Promise<TreeResult> {
  const { history } = options;
  const maxVisible = options.maxVisible ?? 12;

  return new Promise<TreeResult>((resolve) => {
    const input = options.input ?? (process.stdin as TreeOptions["input"]);
    const output = options.output ?? process.stdout;
    const interactive = Boolean(input?.isTTY && output.isTTY);

    if (!interactive && options.allowNonTTY !== true) {
      process.stderr.write("treePrompt requires an interactive terminal.\n");
      resolve({ action: "cancel" });
      return;
    }
    if (!input) {
      resolve({ action: "cancel" });
      return;
    }

    const rootName = options.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? options.root;
    const root = buildTree(options.files, rootName);
    root.expanded = true;
    // Open the first level so the tree isn't a single collapsed line.
    for (const child of root.children) {
      if (child.kind === "folder") child.expanded = true;
    }

    let filter = "";
    let cursor = 0;
    let renderedLines = 0;
    let settled = false;

    /**
     * Nodes to show.
     *
     * Unfiltered, this is plain visibility. Filtered, it matches against the
     * *whole* tree — so a match inside a collapsed folder is still reachable —
     * and keeps the ancestors of each match so the hierarchy stays legible.
     * Folders aren't unconditionally retained, otherwise the filter could never
     * narrow anything and the "no matches" state would be unreachable.
     */
    const shown = (): TreeNode[] => {
      if (filter === "") return visibleNodes(root);

      const all = allNodes(root);
      const keep = new Set<TreeNode>();

      for (const node of all) {
        if (fuzzyFilter([node], filter, (n) => `${n.rel} ${n.name}`).length > 0) {
          for (let at: TreeNode | undefined = node; at; at = parentOf(at, all)) {
            if (keep.has(at)) break;
            keep.add(at);
          }
        }
      }
      return all.filter((node) => keep.has(node));
    };

    const render = () => {
      const width = output.columns ?? 80;
      const nodes = shown();
      if (nodes.length === 0) cursor = 0;
      else if (cursor >= nodes.length) cursor = nodes.length - 1;
      else if (cursor < 0) cursor = 0;

      let start = 0;
      if (cursor >= maxVisible) start = cursor - maxVisible + 1;

      const lines: string[] = [];
      lines.push(`${color.gray("◆")}  ${truncate(options.title ?? rootName, width - 4)}`);

      const shownFilter = filter === "" ? color.gray("none") : filter;
      lines.push(`${color.gray("│")}  ${color.dim("filter ")}${truncate(shownFilter, width - 14)}`);

      const visible = nodes.length === 0 ? [] : nodes.slice(start, start + maxVisible);
      for (const node of visible) {
        lines.push(`${color.gray("│")}  ${treeLine(node, cursor === nodes.indexOf(node), history, width - 6)}`);
      }
      if (nodes.length === 0) {
        lines.push(`${color.gray("│")}`);
        lines.push(`   ${color.yellow("no folders or files match")}`);
      }

      lines.push(`${color.gray("│")}`);
      lines.push(
        `${color.gray("└")}  ${color.dim("↑↓ move · → expand · ← collapse · enter roll · / filter · esc cancel")}  ${color.dim(`${cursor + 1}/${nodes.length}`)}`,
      );

      let out = "";
      if (renderedLines > 0) out += `\u001B[${renderedLines}A\u001B[0J`;
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
      output.write("\u001B[?25h");
      input.pause?.();
    };

    const finish = (result: TreeResult) => {
      cleanup();
      resolve(result);
    };

    function onResize() {
      render();
    }

    function onKeypress(str: string | undefined, key: readline.Key): void {
      if (!key) return;
      const nodes = shown();
      const node = nodes[cursor];

      if (key.ctrl && key.name === "c") {
        finish({ action: "cancel" });
        return;
      }

      if (key.name === "escape") {
        if (filter !== "") {
          filter = "";
          cursor = 0;
          render();
          return;
        }
        finish({ action: "cancel" });
        return;
      }

      if (key.name === "backspace") {
        filter = filter.slice(0, -1);
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

      if (key.name === "right") {
        if (node && node.kind === "folder" && !node.expanded && node.children.length > 0) {
          node.expanded = true;
        } else if (node) {
          cursor += 1;
        }
        render();
        return;
      }

      if (key.name === "left") {
        if (node && node.kind === "folder" && node.expanded) {
          node.expanded = false;
        } else {
          // Jump to the parent row, which is the nearest earlier shallower node.
          const depth = node?.depth ?? 0;
          for (let i = cursor - 1; i >= 0; i -= 1) {
            const candidate = nodes[i]!;
            if (candidate.depth < depth) {
              cursor = i;
              break;
            }
          }
        }
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        if (!node) {
          finish({ action: "browse" });
          return;
        }
        output.write(`\u001B[${renderedLines}A\u001B[0J`);
        output.write(
          `${color.gray("◆")}  ${options.title ?? "tree"} ${color.cyan(truncate(node.rel || ".", 60))}\n`,
        );
        finish({ action: "roll", folder: folderFor(node, options.root), node });
        return;
      }

      if (key.name === "tab") {
        finish({ action: "browse" });
        return;
      }

      if (typeof str === "string" && str.length > 0 && str >= " ") {
        filter += str;
        cursor = 0;
        render();
      }
    }

    // Same keypress plumbing as the list prompt.
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    output.write("\u001B[?25l");
    if (interactive) process.on("SIGWINCH", onResize);
    input.on("keypress", onKeypress);
    input.resume?.();
    render();
  });
}

/** Render one tree row, including guides, marker, name and a watch hint. */
export function treeLine(
  node: TreeNode,
  active: boolean,
  history: History,
  maxWidth: number,
): string {
  const indent = "  ".repeat(Math.max(0, node.depth));
  const pointer = active ? color.cyan("❯") : " ";
  const name = active ? color.cyan(node.name) : node.name;

  let label: string;
  if (node.kind === "folder") {
    const arrow = node.expanded ? "▾" : "▸";
    const count = node.fileCount ?? 0;
    // The root already says how many files it holds; don't repeat it.
    const hint = node.rel === "" ? "" : color.dim(`  ${count}`);
    label = `${color.dim(arrow)} ${name}${hint}`;
  } else {
    const file = node.file;
    const marker = file && history.has(file) ? color.green("✓") : color.dim("○");
    const size = file ? color.dim(formatBytes(file.size)) : "";
    const session = file ? history.watchedMs(file) : 0;
    // There's no known total length, so a session can't honestly be a
    // percentage — it shows as a duration instead.
    const sessionText = session > 0 ? color.dim(`  ${formatDuration(session)}`) : "";
    label = `${marker} ${name}  ${size}${sessionText}`;
  }

  return `${pointer} ${truncate(`${indent}${label}`, Math.max(4, maxWidth))}`;
}

export { CANCEL };
