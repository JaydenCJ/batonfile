# Examples

A complete, realistic handoff: a session that chased a flaky integration
test, found the root cause, drafted a patch — and ran out of context before
applying it. The markdown sources (`summary.md`, `tasks.md`), the session
files under `session/`, and the packed result `ci-flake.baton.json` are all
here. The test suite and `scripts/smoke.sh` repack the baton from these
sources and require byte-identical output, so the example is guaranteed to
stay working.

## Try it

```bash
# from the repository root, after `npm install && npm run build`
node dist/cli.js validate examples/ci-flake.baton.json
node dist/cli.js lint     examples/ci-flake.baton.json
node dist/cli.js show     examples/ci-flake.baton.json
node dist/cli.js unpack   examples/ci-flake.baton.json --out /tmp/restored
node dist/cli.js digest   examples/ci-flake.baton.json
```

## How the baton was packed

```bash
cd examples
node ../dist/cli.js pack \
  --title "Fix the flaky checkout integration test" \
  --summary summary.md --tasks tasks.md \
  --artifact "patch/retry-backoff.diff:code" --artifact "notes/repro.md:doc" \
  --root session \
  --fact branch=fix/checkout-retry --fact stub_port=9402 \
  --agent claude-code --session s-0712 \
  --created-at 2026-07-12T18:04:00Z \
  -o ci-flake.baton.json
```

The fixed `--created-at` makes the pack reproducible: rerunning the command
produces the same bytes and the same digest (`btn_a40eedf7bfc46c44`).

## What each file demonstrates

| File | Demonstrates |
|---|---|
| `summary.md` | Goal/State/Context/Decisions/Constraints sections, heading aliases, bullets |
| `tasks.md` | All four markers (`[ ]`, `[x]`, `[~]`, `[!]`), `(high)`, `(after T3)`, note continuations |
| `session/patch/retry-backoff.diff` | A code artifact, embedded with digest and byte count |
| `session/notes/repro.md` | A doc artifact carried alongside the code |
| `ci-flake.baton.json` | The packed, validated batonfile/1 bundle the next session picks up |
