# Contributing to batonfile

Issues, discussions and pull requests are all welcome — this project aims
to stay small, zero-dependency at runtime, and strict about the format.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/batonfile.git
cd batonfile
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 92 node:test tests
bash scripts/smoke.sh  # end-to-end CLI check against examples/
```

`scripts/smoke.sh` packs the bundled example handoff, then validates,
lints, shows, unpacks, diffs and digests it — including tamper detection
and determinism checks — and must print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable modules
   (the validator, linter, parsers and diff take data, not files).
5. Any change to what validates, to canonical field order, or to an error
   code needs a matching row in `docs/format.md` and a test pinning the
   exact code and JSON path.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined.
- No network calls, ever — batonfile reads and writes local files and
  nothing else.
- **The format is API.** Error codes, JSON paths, exit codes (0/1/2),
  canonical field order and the digest construction are stable within a
  format major version; breaking any of them means `batonfile: "2"`.
- Packing must stay deterministic: the same inputs and `--created-at`
  always produce byte-identical output.
- `unpack` must never write outside `--out`, overwrite without `--force`,
  or write content whose digest does not verify.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `batonfile --version` output, the exact command line, the
baton file (redact embedded content if needed — `sha256`/`bytes` are enough
to reason about integrity bugs), and the full validator output. For format
questions, cite the relevant table in `docs/format.md`.

## Security

Do not open public issues for security problems (especially anything that
lets `unpack` escape its output directory); use GitHub private
vulnerability reporting on this repository instead.
