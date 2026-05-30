---
name: nanograph-lance-windows
description: >
  Use when working on nanograph Windows builds, Lance-backed storage regressions,
  GitHub Actions Windows artifacts, fork/upstream branch refreshes, or repro work
  in nanograph-lance-repro. Captures local lessons from the public Windows
  artifact branch, Lance 6 upgrade, cache reuse, and PR/report workflow.
---

# Nanograph Lance Windows

## First Moves

- Work from the fork artifact branch when validating public Windows binaries: `public-windows-artifacts`.
- Before claiming upstream state, fetch and inspect concrete commits. Do not infer from package versions.
- Keep local user changes. Check `git status --short --branch` before branch, merge, cache, or artifact edits.
- For portable CI helpers, prefer TypeScript under `tools/ci/*.ts` over shell-heavy scripts. Run with `node --experimental-strip-types`.
- On Windows CI, stream long build output with `spawn`, not `spawnSync`; `spawnSync` can hide progress and hit buffer/process issues.

## Upstream Merge Pattern

- Refresh fork branch by starting from `origin/public-windows-artifacts`, then merge `upstream/main` into it. Do not create a sibling branch from upstream if GitHub cache reuse matters.
- Confirm ancestry after merge:

```powershell
git merge-base --is-ancestor origin/public-windows-artifacts HEAD
```

- Keep Windows fix commits on top unless upstream has an equivalent fix verified in source.
- Commit intermediate CI fixes. Long Actions runs need recoverable history.

## Windows Path Fix

Current known upstream issue: Windows absolute paths like `D:\...` can be parsed as URL scheme `d` if code calls `Url::parse(location)` before local-path handling.

Required shape:

- Detect absolute local path first.
- Convert to `file://` URI before dataset URI parsing.
- Add/keep regression test for Windows drive paths.

Look in `crates/nanograph/src/store/namespace.rs`.

Do not drop this patch just because Lance version changed. Lance can reduce symptoms, but nanograph namespace conversion still owns this bug unless upstream code changed.

## GitHub Actions Artifacts

Single Windows workflow should build both user and diagnostic outputs in one cached job:

- Release CLI artifact: `nanograph-windows-x64-cli-release`
- Release TS native binding: `nanograph-ts-win32-x64-msvc-node-release`
- Debug diagnostics artifact: `nanograph-windows-debug-diagnostics`

Expected minimal verification inside CI:

- CLI starts and prints `nanograph 1.3.0` or current package version.
- TS native binding loads in Node and exports `Database`.
- Artifact includes `.sha256` next to `.exe` or `.node`.
- Debug artifact includes build trace JSONL plus debug `.node`.

## Actions Cache Lessons

- Reuse branch-scoped caches by building on the real public branch lineage.
- Cache cargo registry, cargo git, and `target`.
- Cache npm via repo-local `NPM_CONFIG_CACHE`.
- GitHub Actions cache restore accepts at most 10 keys total: primary key plus restore keys. Keep restore keys to 9 or fewer.
- Save cache only on `success()` to avoid saving empty or poisoned caches.
- If a bad tiny cache appears, delete it before rerun instead of trusting restore behavior.

## Windows NPM Process Lesson

On Windows, run `npm` and `npx` through shell when spawned from Node:

```ts
shell: process.platform === "win32" && (command === "npm" || command === "npx")
```

This avoids `spawn npm.cmd EINVAL` class failures.

## Repro Pattern

Use `D:\_nanograph_public\nanograph-lance-repro` for local Lance repro checks.

Good baseline commands:

```powershell
node --experimental-strip-types scripts/repro.ts --iterations 1 --nodes 100 --edges 200 --db .out/repro-small.nano
node --experimental-strip-types scripts/repro.ts --iterations 1 --types 80 --nodes 800 --edges 1600 --db .out/repro-wide.nano
```

Use unique `.out` DB names per run. Compare:

- `Database.init`
- `loadRows.merge`
- `doctor.after-load`
- `Database.open`
- `run.query`

Known useful comparison from Lance 6 public artifact run:

- Wide repro no crash.
- `loadRows.merge`: `128881 ms` old Lance 4 baseline to `7540 ms` Lance 6 artifact, about `17.1x` faster.
- `doctor.after-load`: `19574 ms` to `3533 ms`, about `5.5x` faster.
- Still not fully solved: wide schema has only thousands of rows but many datasets, so remaining slowdown likely per-dataset/per-schema overhead.

## Debug And Perf

CI build trace is not runtime profiling. It proves build, package, and smoke verification phases only.

Debug `.node` helps with:

- Crash repro under debugger.
- Full Rust backtraces.
- `RUST_LOG=trace` runtime logs if code emits them.

For perf root cause, add runtime JSONL tracing behind env flag, for example `NANOGRAPH_WRITE_TRACE=1`.

Trace per dataset/type:

- row count
- open time
- write/merge time
- commit time
- manifest publish time
- namespace update time
- node vs edge dataset

Likely optimization targets:

- skip empty datasets
- avoid opening/committing datasets with no rows
- batch/group writes by dataset
- avoid manifest/namespace updates when unchanged
- make doctor optional or outside hot write path

## Report/PR Style

When reporting external status, separate solved from remaining:

- Solved: Windows artifact builds, TS binding loads, crash/runtime smoke test passes.
- Improved: wide `loadRows.merge` much faster after Lance 6.
- Not solved: remaining wide-schema overhead still visible and needs runtime instrumentation.

Use direct links to GitHub Actions run and artifact names. Do not claim a binary is fixed without local or CI load verification.
