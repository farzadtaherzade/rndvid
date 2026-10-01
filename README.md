# rndvid

[English](README.md) · [فارسی](README.fa.md)

Pick a random video, book or audio file from a folder and open it with whatever
app handles that format.

```
bun run src/index.ts
```

Asks what you're picking, lets you browse any drive, and rolls N unique files
that open one after another — waiting for each to close before the next.

## Requirements

Bun (or Node 18+, since only Node built-ins are used). No `ffprobe`, no
`ffmpeg`, no other external tools.

## Usage

```
bun run src/index.ts [options]
```

| Option | Meaning |
| --- | --- |
| `-f, --folder <path>` | Library folder. Skips the browser. |
| `-n, --count <n>` | How many to roll. Default 1. |
| `--mode <name>` | `video`, `book` or `audio`. Skips the media menu. |
| `--max-depth <n>` | Folders to descend. Default 4. `0` = unlimited. |
| `--size <range>` | Size filter. See below. |
| `--exclude-watched` | Skip files you've already opened. |
| `--detach` | Don't wait for the app to close. |
| `--library` | Browse the whole library instead of rolling. |
| `--dry-run` | Print the picks without asking anything or opening. |
| `-h, --help` | Usage. |

## Media modes

The first thing you're asked is what you're picking. Each mode scans for only
its own formats, so a book scan doesn't drag in every video on the drive.

| Mode | Formats |
| --- | --- |
| `video` | mp4 mkv avi mov webm m4v ts wmv flv mpg mpeg ogv |
| `book` | epub pdf mobi azw azw3 fb2 djvu cbz cbr m4b m4a aac |
| `audio` | mp3 m4a m4b aac flac wav ogg opus wma aiff |

Audiobooks (`.m4b`) deliberately belong to both `book` and `audio`. Whatever
mode you pick, files open in your default app for that extension — `.epub` in
your reader, `.mkv` in your player.

Your choice is remembered, so the menu only appears the first time or when you
ask to change it with `m` at the end of a roll.

## Other drives

The folder browser lists drives and shows free space. **Change drive…** is
available at every level, not just at a drive root, so you can jump from
`C:\Users\…` to `D:\` without walking back out.

## Scan depth

Scans are recursive but capped at 4 folders deep by default, which skips the
worst of `D:\` and `C:\` while still reaching shows nested inside course
folders. When the cap truncates a scan, it says so and names a folder that was
cut off — you're never silently missing files.

```
--max-depth 2    shallow: only folders right below the root
--max-depth 0    unlimited
```

System folders (`Windows`, `WinSxS`, `Program Files`, `DriverStore`, and friends)
are skipped by name at any depth. Unreadable folders are reported and skipped,
never fatal. Symlinks are tracked by realpath, so a circular link can't make the
scan loop.

## Returning to your last folder

When you've confirmed a library before, the next run offers it:

```
◆  Return to D:\Videos\Some Show?  (298 videos)
│  ❯ Yes
│    No, pick a folder
```

Your answer is remembered. Answer yes and it stops asking entirely; answer no and
it goes straight to the browser. Recent folders are one keystroke away with `R`,
and folders you've since deleted are pruned so the list never fills with paths
that can't be opened.

## Tree view

`t` opens a collapsible tree of the library:

```
◆  Video library
│  filter none
│  ❯ ▾ library
│      ▾ Season 1  2
│        ✓ S01E01.mkv    700 MiB  22m
│        ○ S01E02.mkv    668 MiB
│      ▾ Season 2  13
│      ○ top.mp4         150 MiB
│
└  ↑↓ move · → expand · ← collapse · enter roll · / filter · esc cancel   1/8
```

`↑↓` to move, `→` expand, `←` collapse, `Enter` to roll from the selected folder.
`/` filters the tree, keeping ancestors so the path stays readable. `✓` means
opened, `○` means not yet, and the trailing duration is how long you had it open.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `1` `3` `5` | roll 1 / 3 / 5 |
| `a` | roll everything |
| `t` | tree view |
| `r` | recently opened files |
| `R` | recent folders |
| `f` | size filter |
| `u` | undo the last pick |
| `w` | skip already-opened on/off |
| `l` | library view |
| `d` | change folder |
| `m` | change media mode |
| `?` | help panel |
| `q` | quit |

`Enter` is the default: roll again the same way.

## In the browser

Type to filter, `↑`/`↓` to move, `Enter` to open a folder or confirm the scan,
`Esc` to clear the search — and a second `Esc` to cancel.

## Size filters

```
500mb        at least 500 MiB
>1gb         same thing, spelled explicitly
1gb-         at least 1 GiB
-800mb       at most 800 MiB
<800mb       same thing, spelled explicitly
200mb-2gb    between the two
700-900      bare numbers mean megabytes
```

Units: `b`, `kb`, `mb`, `gb`, `tb` (also `KiB`/`MiB`/`GiB`/`TiB`). A bare
number is megabytes, since that's the unit you'd normally pick a video size in.

There's no duration or resolution filter — that needs `ffprobe`, which this
deliberately doesn't require. Filtering is by file size only.

## Size filters

```
500mb        at least 500 MiB
>1gb         same thing, spelled explicitly
1gb-         at least 1 GiB
-800mb       at most 800 MiB
<800mb       same thing, spelled explicitly
200mb-2gb    between the two
700-900      bare numbers mean megabytes
```

Units: `b`, `kb`, `mb`, `gb`, `tb` (also `KiB`/`MiB`/`GiB`/`TiB`). A bare
number is megabytes, since that's the unit you'd normally pick a video size in.

There's no duration or resolution filter — that needs `ffprobe`, which this
deliberately doesn't require. Filtering is by file size only.

## Roll behaviour

`--count N` selects N **unique** files via a partial Fisher-Yates shuffle, so
never a repeat and never a modulo-biased draw. They're opened in order, each
launched when the previous app closes.

"Already watched" is per-folder state in `%APPDATA%\rndvid\history`, keyed by a
hash of the folder path, and recorded on *launch* rather than on completion — a
player that fails to start still counts, so you won't re-roll the same broken
file forever. History is keyed by path relative to the folder, so renaming or
moving files inside your library keeps their history. `u` undoes the last mark
and puts the file back in the pool.

### Resume where you stopped — read this before expecting it to work

There is **no** way to resume playback position on Windows without the player's
cooperation, and each player wants different flags. What this actually does:

- Records how long you had each file open (wall-clock, from launch to the app
  exiting) and keeps the longest session.
- Shows that as a real duration next to the file in the tree.

So `22m` next to an episode means "you had it open for 22 minutes", which is a
proxy for how far in you got — **not** a verified position. If your player
supports seeking, you can define a resume-argument template in settings (for
example `mpv --start={time}`), but it's off by default because getting it wrong
per player is worse than not offering it.

## Opening files

Windows stores only a ProgID at `HKCR\.mp4`; the launch command lives under that
ProgID, so the app walks `HKCR\.ext` → ProgID → `shell\open\command`, then
spawns the real executable so it can wait for the process to exit. `cmd /c start`
is only the fallback, because it hands off to the shell and returns immediately,
which would make "wait for the app to close" meaningless.

`REG_EXPAND_SZ` values are expanded, and both `%1` and `%L` placeholders are
supported (Windows Media Player uses the latter). Associations that delegate via
`DelegateExecute` need COM, so those fall back to `start`.

This is per-extension, so it works the same for `.epub` and `.flac` as it does
for `.mkv`. Which app that resolves to depends entirely on your file
associations — check one with:

```
reg query "HKCR\.mp4"
```

## Tests

```
bun run typecheck   # tsc, strict
bun run test        # 132 unit tests: RNG, filters, fuzzy, registry, scan, history, tree
bun run test:e2e    # 83 end-to-end checks driving the real CLI
bun run check       # all three
```

Unit tests cover the pure logic, including a chi-square check on the RNG, a live
read of your own registry, the depth cap against synthetic trees at known depths,
the tree builder's folding and sorting, and undo/session bookkeeping. The e2e
suite drives the actual binary via `--dry-run` against a temp fixture, asserting
on roll uniqueness, per-mode format isolation, size filters, depth truncation,
recent-folder tracking, history, and argument validation.

The interactive prompts are tested by injecting fake streams
(`tests/search-select.test.ts`, `tests/tree.test.ts`), because keystroke-driven
testing via node-pty doesn't work on this machine — its ConPTY backend delivers
no input to the child, even to a plain `readline` script. That was verified
before being ruled out; the prompts' key handling, filtering, and redraw logic are
covered the injectable way instead.

For scale: a `--dry-run` over a 62 GB drive holding shows and course recordings
found just under 1000 videos across 136 folders in about 1.4 seconds, matching a
manual PowerShell count of the same tree exactly.

## Layout

```
src/
  index.ts         argument parsing, the roll/play loop
  tree.ts          collapsible library tree
  shortcuts.ts     key bindings and the help panel
  recent.ts        recently opened files
  keypress.ts      single-keystroke reader for the action bar
  scan.ts          recursive walk, depth cap, symlink and permission handling
  filters.ts       size parsing and filtering
  random.ts        unbiased RNG, N-unique selection
  fuzzy.ts         subsequence matcher with positional scoring
  search-select.ts the searchable list prompt
  picker.ts        media menu, drive picker, folder browser, library view
  player.ts        Windows association resolution and launching
  history.ts       per-folder watch history, undo, session lengths
  config.ts        %APPDATA% paths, settings, recent folders
  extensions.ts    per-mode format tables
  ui.ts            colour, panels, durations
```

Note that `ts` is in the video list, so pointing video mode at a source tree
will offer TypeScript files as videos.

## Notes

- The folder you confirm is remembered in `%APPDATA%\rndvid\settings.json` and
  becomes the browser's starting point next run, along with your media mode.
- History is keyed by folder but shared across modes, so switching from video to
  book in the same folder sees the same "already opened" marks. That's usually
  what you want, since a folder holds one kind of library in practice.
- `RNDVID_DATA_DIR` overrides the settings/history location, which is what the
  e2e tests use to avoid touching your real profile.
- A run with neither `--mode` nor a remembered mode falls back to `video` when
  there's no terminal to prompt on, so `--dry-run` works in scripts.
