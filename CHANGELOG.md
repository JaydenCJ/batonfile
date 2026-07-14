# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-13

### Added

- The **batonfile/1 interchange format** (specified field-by-field in
  `docs/format.md`): structured summary (goal, state, context, decisions,
  constraints), tasks with statuses/priorities/blockers, digest-carrying
  artifacts (embedded or by reference), flat facts, producer identity,
  and `x-` extension keys for forward compatibility.
- Three-layer validator with stable error codes and JSON paths:
  structural (types, enums, patterns, limits), referential (unique task
  ids, blocker references, `blocked_by` cycle detection with the full
  chain reported, unique and traversal-safe artifact paths) and integrity
  (embedded content must decode and match its declared sha256 and bytes).
- Canonical serialization (fixed field order, sorted facts and extension
  keys) and the content-addressed baton digest `btn_…`, invariant under
  key order and whitespace.
- Handoff-quality linter with 11 rules: leftover placeholders, thin
  goal/state, missing open work, blocked tasks with no blocker, stale
  blockers, duplicate titles, unverifiable by-reference artifacts,
  oversized embeds and bundles, future timestamps.
- `batonfile pack`: builds a baton from flags plus two markdown front
  doors — `## Goal`/`## State` summary sections (with aliases) and
  GitHub-style task lists extended with `[~]`/`[!]`, `(high)`/`(low)` and
  `(after T1)` annotations; artifacts embed up to `--max-embed` with
  digests always recorded; deterministic output with `--created-at`.
- `batonfile validate`, `lint --strict`, `show` (a markdown briefing whose
  task list round-trips through the pack parser), `unpack` (digest-verified,
  all-or-nothing, traversal-proof extraction), `diff` (tasks by id,
  artifacts by path with sha256-based content detection, GNU-style exit
  codes), `digest` and `init`.
- Public programmatic API (`validateBaton`, `lintBaton`, `createBaton`,
  `parseSummaryMarkdown`, `parseTaskList`, `canonicalize`, `batonDigest`,
  `renderBriefing`, `diffBatons`, `unpackBaton`) with type declarations.
- A complete worked example (`examples/`) that the suite repacks
  byte-identically, 92 node:test tests, and an end-to-end
  `scripts/smoke.sh`.

[0.1.0]: https://github.com/JaydenCJ/batonfile/releases/tag/v0.1.0
