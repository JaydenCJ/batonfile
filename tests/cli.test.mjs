// End-to-end tests against the compiled CLI in a child process: exit
// codes, output shapes, determinism, and the full producer→consumer flow
// (pack → validate → show → unpack → diff) in a temp workspace.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { minimalBaton, PKG, runCli, tempDir, WHEN } from "./helpers.mjs";

test("--version prints exactly the package.json version", () => {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const r = runCli(["--version"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("--help documents every command; per-command help works", () => {
  const r = runCli(["--help"]);
  assert.equal(r.code, 0);
  for (const cmd of ["init", "pack", "validate", "lint", "show", "unpack", "diff", "digest"]) {
    assert.ok(r.stdout.includes(cmd), `--help missing ${cmd}`);
  }
  const packHelp = runCli(["pack", "--help"]);
  assert.equal(packHelp.code, 0);
  assert.ok(packHelp.stdout.includes("--max-embed"));
});

test("usage errors exit 2: unknown command, unknown flag, missing file", (t) => {
  const dir = tempDir(t);
  assert.equal(runCli(["frobnicate"]).code, 2);
  assert.equal(runCli(["validate", "--wat", "x.json"], { cwd: dir }).code, 2);
  const missing = runCli(["validate", "nope.json"], { cwd: dir });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /cannot read nope.json/);
});

test("init writes a valid baton, refuses to clobber, and lint flags the TODOs", (t) => {
  const dir = tempDir(t);
  assert.equal(runCli(["init", "--agent", "claude-code"], { cwd: dir }).code, 0);
  assert.equal(runCli(["validate", "baton.json"], { cwd: dir }).code, 0, "template must be schema-valid");
  const again = runCli(["init"], { cwd: dir });
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already exists/);
  const lint = runCli(["lint", "baton.json"], { cwd: dir });
  assert.equal(lint.code, 0, "warnings are not errors without --strict");
  assert.match(lint.stdout, /W_PLACEHOLDER/);
  assert.equal(runCli(["lint", "--strict", "baton.json"], { cwd: dir }).code, 1);
});

test("pack builds a validating baton from flags and markdown files", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "summary.md"), "## Goal\n\nMake the checkout suite reliable.\n\n## State\n\nPatch drafted, not yet applied.\n\n## Constraints\n\n- keep the public API stable\n");
  writeFileSync(join(dir, "tasks.md"), "- [x] find the root cause\n- [ ] apply the patch (high) (after 1)\n");
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "work/fix.diff"), "--- a/x\n+++ b/x\n");
  const r = runCli([
    "pack", "--title", "Checkout flake handoff",
    "--summary", "summary.md", "--tasks", "tasks.md",
    "--task", "! get deploy access (after T2)",
    "--artifact", "work/fix.diff:code",
    "--fact", "branch=fix/retry",
    "--agent", "test-agent",
    "--created-at", WHEN,
  ], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^packed btn_[0-9a-f]{16} -> baton.json \(3 task\(s\), 1 artifact\(s\), 16 B embedded\)$/m);
  assert.equal(runCli(["validate", "baton.json"], { cwd: dir }).code, 0);
  const doc = JSON.parse(readFileSync(join(dir, "baton.json"), "utf8"));
  assert.equal(doc.tasks.length, 3);
  assert.deepEqual(doc.tasks[2], { id: "T3", title: "get deploy access", status: "blocked", blocked_by: ["T2"] });
  assert.equal(doc.artifacts[0].role, "code");
});

test("pack is deterministic: same inputs and --created-at give identical bytes", (t) => {
  const dir = tempDir(t);
  const args = ["pack", "--title", "t", "--goal", "a goal long enough", "--state", "a state long enough", "--created-at", WHEN, "--stdout", "--quiet"];
  const one = runCli(args, { cwd: dir });
  const two = runCli(args, { cwd: dir });
  assert.equal(one.code, 0);
  assert.equal(one.stdout, two.stdout);
  assert.ok(one.stdout.endsWith("}\n"));
});

test("pack respects --max-embed and --no-embed (digests always recorded)", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "small.txt"), "tiny");
  writeFileSync(join(dir, "large.txt"), "x".repeat(100));
  const r = runCli([
    "pack", "--title", "t", "--goal", "a goal long enough", "--state", "a state long enough",
    "--artifact", "small.txt", "--artifact", "large.txt",
    "--max-embed", "10", "--created-at", WHEN, "--stdout", "--quiet",
  ], { cwd: dir });
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.artifacts[0].embed !== undefined, "small file embeds");
  assert.equal(doc.artifacts[1].embed, undefined, "large file goes by reference");
  assert.match(doc.artifacts[1].sha256, /^[0-9a-f]{64}$/);
});

test("--max-embed rejects non-integer values instead of truncating them", (t) => {
  // Number.parseInt("64k") is 64; a silently misread size limit would embed
  // far less than the user asked for, so anything but digits is a usage error.
  const dir = tempDir(t);
  const r = runCli([
    "pack", "--title", "t", "--goal", "a goal long enough", "--state", "a state long enough",
    "--max-embed", "64k", "--created-at", WHEN, "--stdout", "--quiet",
  ], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--max-embed must be a non-negative integer \(bytes\), got "64k"/);
});

test("validate reports path, message and code, and --quiet silences output", (t) => {
  const dir = tempDir(t);
  const broken = minimalBaton({ tasks: [{ id: "T1", title: "t", status: "paused" }] });
  writeFileSync(join(dir, "bad.json"), JSON.stringify(broken));
  const r = runCli(["validate", "bad.json"], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /bad.json: INVALID — 1 error\(s\)/);
  assert.match(r.stdout, /tasks\[0\].status: .* \[E_ENUM\]/);
  const quiet = runCli(["validate", "--quiet", "bad.json"], { cwd: dir });
  assert.equal(quiet.code, 1);
  assert.equal(quiet.stdout, "");
});

test("a JSON syntax error is a finding (exit 1), not a crash", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "mangled.json"), "{ not json");
  const r = runCli(["validate", "mangled.json"], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
});

test("show renders the briefing to stdout for a valid baton only", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "baton.json"), JSON.stringify(minimalBaton()));
  const r = runCli(["show", "baton.json"], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^# Baton: Fix the flaky checkout integration test\n/);
  assert.match(r.stdout, /- \[ \] T1 · Apply the backoff patch/);
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ batonfile: "1" }));
  assert.equal(runCli(["show", "bad.json"], { cwd: dir }).code, 1);
});

test("digest is stable across key order; diff follows the GNU exit convention", (t) => {
  const dir = tempDir(t);
  const baton = minimalBaton({ facts: { b: "2", a: "1" } });
  writeFileSync(join(dir, "one.json"), JSON.stringify(baton));
  const scrambled = { facts: { a: "1", b: "2" }, ...baton };
  writeFileSync(join(dir, "two.json"), JSON.stringify(scrambled));
  const d1 = runCli(["digest", "one.json"], { cwd: dir });
  const d2 = runCli(["digest", "two.json"], { cwd: dir });
  assert.equal(d1.stdout, d2.stdout);
  assert.equal(runCli(["diff", "one.json", "two.json"], { cwd: dir }).code, 0, "identical -> 0");

  const changed = minimalBaton({ facts: { a: "1", b: "2" } });
  changed.tasks = [{ id: "T1", title: "Apply the backoff patch", status: "done" }];
  writeFileSync(join(dir, "three.json"), JSON.stringify(changed));
  const diff = runCli(["diff", "one.json", "three.json"], { cwd: dir });
  assert.equal(diff.code, 1, "differences -> 1");
  assert.match(diff.stdout, /~ task T1: status open -> done/);
  assert.equal(runCli(["diff", "one.json", "missing.json"], { cwd: dir }).code, 2, "trouble -> 2");
});

test("unpack extracts embedded files, verifies digests, and honors --force", (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/original.txt"), "carried across the handoff\n");
  const pack = runCli([
    "pack", "--title", "t", "--goal", "a goal long enough", "--state", "a state long enough",
    "--artifact", "src/original.txt", "--created-at", WHEN,
  ], { cwd: dir });
  assert.equal(pack.code, 0, pack.stderr);
  const r = runCli(["unpack", "baton.json", "--out", "restored"], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /sha256 ok/);
  assert.equal(
    readFileSync(join(dir, "restored/src/original.txt"), "utf8"),
    "carried across the handoff\n"
  );
  const again = runCli(["unpack", "baton.json", "--out", "restored"], { cwd: dir });
  assert.equal(again.code, 1, "existing files are a finding without --force");
  assert.equal(runCli(["unpack", "baton.json", "--out", "restored", "--force"], { cwd: dir }).code, 0);
});

test("a tampered embed is caught by validate and refused by unpack", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "note.txt"), "authentic content\n");
  runCli(["pack", "--title", "t", "--goal", "a goal long enough", "--state", "a state long enough", "--artifact", "note.txt", "--created-at", WHEN], { cwd: dir });
  const doc = JSON.parse(readFileSync(join(dir, "baton.json"), "utf8"));
  doc.artifacts[0].embed.content = "forged content!!!\n"; // same length
  writeFileSync(join(dir, "baton.json"), JSON.stringify(doc));
  const v = runCli(["validate", "baton.json"], { cwd: dir });
  assert.equal(v.code, 1);
  assert.match(v.stdout, /E_DIGEST/);
  assert.equal(runCli(["unpack", "baton.json", "--out", "x"], { cwd: dir }).code, 1);
});
