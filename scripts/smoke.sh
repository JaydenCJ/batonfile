#!/usr/bin/env bash
# Smoke test for batonfile: exercises the real CLI end to end — pack a
# baton from the bundled example sources, validate, lint, show, unpack,
# diff and digest it, and confirm tampering is caught. No network,
# idempotent, runs from a clean checkout (after `npm install`). Prints
# "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents every subcommand.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in init pack validate lint show unpack diff digest; do
  echo "$HELP" | grep -q "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Exit codes: unknown commands and unreadable files exit 2.
set +e
$CLI frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$CLI validate "$WORKDIR/nope.json" >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing file should exit 2"; }
set -e
echo "[smoke] exit codes ok (2 usage/io)"

# 4. Pack from the bundled example sources, deterministically.
PACK_ARGS=(pack
  --title "Fix the flaky checkout integration test"
  --summary "$ROOT/examples/summary.md" --tasks "$ROOT/examples/tasks.md"
  --artifact "patch/retry-backoff.diff:code" --artifact "notes/repro.md:doc"
  --root "$ROOT/examples/session"
  --fact branch=fix/checkout-retry --fact stub_port=9402
  --agent claude-code --session s-0712
  --created-at 2026-07-12T18:04:00Z)
$CLI "${PACK_ARGS[@]}" -o "$WORKDIR/one.json" | grep -q "packed btn_" || fail "pack did not report a digest"
$CLI "${PACK_ARGS[@]}" -o "$WORKDIR/two.json" --quiet
cmp -s "$WORKDIR/one.json" "$WORKDIR/two.json" || fail "pack is not deterministic"
cmp -s "$WORKDIR/one.json" "$ROOT/examples/ci-flake.baton.json" || fail "bundled example baton is stale (repack it)"
echo "[smoke] pack ok (deterministic, matches bundled example)"

# 5. validate accepts it and reports the digest; lint is clean.
VAL_OUT="$($CLI validate "$WORKDIR/one.json")"
echo "$VAL_OUT" | grep -q "OK — batonfile/1" || fail "validate output wrong: $VAL_OUT"
$CLI lint "$WORKDIR/one.json" | grep -q "clean — no warnings" || fail "example baton should lint clean"
echo "[smoke] validate + lint ok"

# 6. digest is invariant under key scrambling.
DIGEST="$($CLI digest "$WORKDIR/one.json")"
node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const flip = (v) => Array.isArray(v) ? v.map(flip)
    : (v && typeof v === "object")
      ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, flip(x)]))
      : v;
  fs.writeFileSync(process.argv[2], JSON.stringify(flip(doc)));
' "$WORKDIR/one.json" "$WORKDIR/scrambled.json"
[ "$($CLI digest "$WORKDIR/scrambled.json")" = "$DIGEST" ] || fail "digest not key-order invariant"
$CLI diff "$WORKDIR/one.json" "$WORKDIR/scrambled.json" | grep -q "identical ($DIGEST)" || fail "diff should call scrambled copy identical"
echo "[smoke] digest ok ($DIGEST, key-order invariant)"

# 7. show renders the briefing with round-trippable task markers.
SHOW_OUT="$($CLI show "$WORKDIR/one.json")"
echo "$SHOW_OUT" | grep -q "# Baton: Fix the flaky checkout integration test" || fail "show missing title"
echo "$SHOW_OUT" | grep -q -- "- \[~\] T3 · high · Apply the backoff patch" || fail "show missing in-progress task"
echo "$SHOW_OUT" | grep -q "2 embedded, 1.1 KiB carried" || fail "show missing artifact summary"
echo "[smoke] show ok (briefing rendered)"

# 8. unpack restores the artifacts byte-for-byte and refuses to clobber.
$CLI unpack "$WORKDIR/one.json" --out "$WORKDIR/restored" | grep -q "unpacked 2 file(s)" || fail "unpack count wrong"
cmp -s "$WORKDIR/restored/patch/retry-backoff.diff" "$ROOT/examples/session/patch/retry-backoff.diff" || fail "unpacked diff differs"
cmp -s "$WORKDIR/restored/notes/repro.md" "$ROOT/examples/session/notes/repro.md" || fail "unpacked notes differ"
set +e
$CLI unpack "$WORKDIR/one.json" --out "$WORKDIR/restored" >/dev/null 2>&1
[ $? -eq 1 ] || { set -e; fail "unpack over existing files should exit 1"; }
set -e
echo "[smoke] unpack ok (byte-identical, no clobber)"

# 9. Tampering with embedded content is caught (validate exit 1, E_DIGEST).
node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  doc.artifacts[0].embed.content = doc.artifacts[0].embed.content.replace("450", "999");
  fs.writeFileSync(process.argv[2], JSON.stringify(doc));
' "$WORKDIR/one.json" "$WORKDIR/tampered.json"
set +e
TAMPER_OUT="$($CLI validate "$WORKDIR/tampered.json")"; TAMPER_CODE=$?
set -e
[ "$TAMPER_CODE" -eq 1 ] || fail "tampered baton should exit 1, got $TAMPER_CODE"
echo "$TAMPER_OUT" | grep -q "E_DIGEST" || fail "tamper not reported as E_DIGEST: $TAMPER_OUT"
echo "[smoke] integrity ok (tampered embed caught)"

# 10. diff between two sessions: task done, new task, state rewritten.
node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  doc.tasks[3].status = "done";
  doc.tasks.push({ id: "T6", title: "Write the postmortem", status: "open" });
  doc.summary.state = "Backoff patch applied and verified across 50 clean runs.";
  fs.writeFileSync(process.argv[2], JSON.stringify(doc));
' "$WORKDIR/one.json" "$WORKDIR/next.json"
set +e
DIFF_OUT="$($CLI diff "$WORKDIR/one.json" "$WORKDIR/next.json")"; DIFF_CODE=$?
set -e
[ "$DIFF_CODE" -eq 1 ] || fail "diff with changes should exit 1, got $DIFF_CODE"
echo "$DIFF_OUT" | grep -q "~ task T4: status open -> done" || fail "diff missing status change"
echo "$DIFF_OUT" | grep -q '+ task T6 \[open\] "Write the postmortem"' || fail "diff missing added task"
echo "[smoke] diff ok (session-to-session changes)"

# 11. init writes a valid template and lint pushes back on the TODOs.
(cd "$WORKDIR" && $CLI init --agent smoke-agent >/dev/null)
$CLI validate --quiet "$WORKDIR/baton.json" || fail "init template must validate"
$CLI lint "$WORKDIR/baton.json" | grep -q "W_PLACEHOLDER" || fail "lint should flag init TODOs"
set +e
$CLI lint --strict "$WORKDIR/baton.json" >/dev/null; [ $? -eq 1 ] || { set -e; fail "lint --strict should exit 1 on warnings"; }
set -e
echo "[smoke] init + lint ok (placeholders flagged)"

echo "SMOKE OK"
