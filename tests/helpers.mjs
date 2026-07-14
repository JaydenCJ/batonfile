// Shared test helpers: baton factories, artifact builders with real
// digests, a temp-dir helper and a child-process CLI runner. Deterministic
// throughout — fixed timestamps, fresh temp dirs, no network, no
// wall-clock assumptions.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
export const PKG = fileURLToPath(new URL("../package.json", import.meta.url));

/** A fixed instant used everywhere a baton needs a timestamp. */
export const WHEN = "2026-07-12T18:04:00Z";

/** Run the real CLI in a child process; returns {code, stdout, stderr}. */
export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Fresh temp dir, removed when the test (and its subtests) finish. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "batonfile-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** A small but realistic valid baton; override any top-level field. */
export function minimalBaton(overrides = {}) {
  return {
    batonfile: "1",
    title: "Fix the flaky checkout integration test",
    created_at: WHEN,
    summary: {
      goal: "Make the checkout integration test pass reliably on every run.",
      state: "Root cause found; backoff patch drafted but not applied yet.",
    },
    tasks: [{ id: "T1", title: "Apply the backoff patch", status: "open" }],
    ...overrides,
  };
}

/** An artifact whose sha256/bytes really match the embedded utf8 text. */
export function textArtifact(path, text, extra = {}) {
  return {
    path,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
    embed: { encoding: "utf8", content: text },
    ...extra,
  };
}

/** A by-reference artifact (digest only, no embedded content). */
export function refArtifact(path, text, extra = {}) {
  return {
    path,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
    ...extra,
  };
}

/** Shorthand: codes of all issues, in order. */
export function codes(issues) {
  return issues.map((i) => i.code);
}

/** Shorthand: the issues that sit at exactly this JSON path. */
export function at(issues, path) {
  return issues.filter((i) => i.path === path);
}
