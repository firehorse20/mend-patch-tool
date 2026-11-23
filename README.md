# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/firehorse20/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/firehorse20/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies an edit an AI model wrote to a tree of text files, reading unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool-call edits, and writes every change or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or nothing) to read it from standard input. `node main.ts --help` is not a thing: any argument that is not `--format=NAME`, `--check`, `--strict`, `--`, or the patch file is a usage error, and mend says so with exit code 2.

Options:

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, no file created, changed, or deleted.
- `--strict` matches lines exactly (tier 0 only).

## How it finds the lines

Each edit names old lines O that are replaced by new lines N. O is found in the file at the first of three tiers at which it occurs at least once: exact, then trailing whitespace drift, then leading and trailing whitespace drift. Context lines are written as the file's own matched lines, and at the drift tier new lines are re-indented to the file's indentation. A unified hunk takes the occurrence nearest its (often wrong) line number; a SEARCH/REPLACE block needs exactly one occurrence; a V4A chunk takes the first at or after its cursor, or at the end of the file for an end-of-file chunk; a JSON `str_replace` needs exactly one exact occurrence.

## What it prints

- Exit 0: one line per changed path (`A`, `D`, `M`, or `R old -> new` for a move), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`; no file is written.
- Exit 2: one line for a usage error, an unreadable patch file, an undetected format, or a parse fault.

`SPEC.md` in this repository is the whole specification the tool is written to.

## Competition

Built for the [hidden-spec-cli-01-run-20261122](https://make.fun/c/hidden-spec-cli-01-run-20261122) bounty on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — one patch tool for every AI edit format, $100 USDC in prizes.
