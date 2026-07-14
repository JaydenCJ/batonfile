// Lint is the difference between "parses" and "won't strand the receiver".
// Each rule gets a positive and a negative: the warning must fire on the
// bad shape and stay silent on the good one, with a pinned code and path.
// The clock is injected so nothing here depends on wall time.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lintBaton, LINT_LIMITS } from "../dist/lint.js";
import { codes, minimalBaton, refArtifact, textArtifact, WHEN } from "./helpers.mjs";

/** Fixed "now": one hour after the shared baton timestamp. */
const NOW = Date.parse(WHEN) + 60 * 60 * 1000;

function lint(baton) {
  return lintBaton(baton, { now: NOW });
}

test("a well-formed handoff lints clean", () => {
  assert.deepEqual(lint(minimalBaton()), []);
});

test("thin goal and state each warn with their length", () => {
  const baton = minimalBaton();
  baton.summary = { goal: "fix tests", state: "wip" };
  const issues = lint(baton);
  assert.deepEqual(codes(issues), ["W_THIN_GOAL", "W_THIN_STATE"]);
  assert.match(issues[0].message, /9 characters/);
});

test("leftover TODO/FIXME/TBD placeholders warn wherever they sit", () => {
  const baton = minimalBaton({
    title: "TODO: name this handoff",
    tasks: [{ id: "T1", title: "FIXME before merging", status: "open" }],
  });
  baton.summary.context = ["deploy target TBD"];
  const issues = lint(baton).filter((i) => i.code === "W_PLACEHOLDER");
  assert.deepEqual(issues.map((i) => i.path), ["title", "summary.context[0]", "tasks[0].title"]);
  // "TODOS" as part of a word does not fire.
  const fine = minimalBaton({ title: "Track mastodon toots" });
  assert.deepEqual(lint(fine), []);
});

test("no tasks at all, or only done tasks, warns about missing open work", () => {
  const none = lint(minimalBaton({ tasks: undefined }));
  assert.deepEqual(codes(none), ["W_NO_OPEN_TASKS"]);
  const allDone = lint(minimalBaton({ tasks: [{ id: "T1", title: "shipped it", status: "done" }] }));
  assert.deepEqual(codes(allDone), ["W_NO_OPEN_TASKS"]);
  assert.match(allDone[0].message, /every task is done/);
});

test("a blocked task with no blocker and no notes is a dead end", () => {
  const bare = minimalBaton({ tasks: [{ id: "T1", title: "wait for access", status: "blocked" }] });
  assert.ok(codes(lint(bare)).includes("W_BLOCKED_NO_BLOCKER"));
  // Notes explaining the blockage are enough to silence it.
  const explained = minimalBaton({
    tasks: [{ id: "T1", title: "wait for access", status: "blocked", notes: "needs ops to grant deploy rights" }],
  });
  assert.ok(!codes(lint(explained)).includes("W_BLOCKED_NO_BLOCKER"));
});

test("a blocked task whose blockers are all done is stale", () => {
  const baton = minimalBaton({
    tasks: [
      { id: "T1", title: "land the patch", status: "done" },
      { id: "T2", title: "verify the fix", status: "blocked", blocked_by: ["T1"] },
    ],
  });
  const issues = lint(baton);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "W_STALE_BLOCKER");
  assert.equal(issues[0].path, "tasks[1].blocked_by");
});

test("a blocked task with a live blocker is fine", () => {
  const baton = minimalBaton({
    tasks: [
      { id: "T1", title: "land the patch", status: "open" },
      { id: "T2", title: "verify the fix", status: "blocked", blocked_by: ["T1"] },
    ],
  });
  assert.deepEqual(lint(baton), []);
});

test("duplicate task titles warn once, at the later task, after normalization", () => {
  const baton = minimalBaton({
    tasks: [
      { id: "T1", title: "Fix the  Login Bug", status: "open" },
      { id: "T2", title: "fix the login bug", status: "open" },
    ],
  });
  const issues = lint(baton);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "W_DUPLICATE_TITLE");
  assert.equal(issues[0].path, "tasks[1].title");
});

test("by-reference artifacts warn that the receiver cannot reconstruct them", () => {
  const baton = minimalBaton({ artifacts: [refArtifact("data/big.parquet", "pretend")] });
  const issues = lint(baton);
  assert.deepEqual(codes(issues), ["W_UNVERIFIABLE_ARTIFACT"]);
  assert.match(issues[0].message, /by reference/);
});

test("oversized embeds warn per artifact; bloated totals warn for the bundle", () => {
  // lint reads the declared byte counts; content itself is validate's job.
  const big = { ...textArtifact("a.bin", "x"), bytes: LINT_LIMITS.largeEmbed + 1 };
  const perFile = lint(minimalBaton({ artifacts: [big] }));
  assert.deepEqual(codes(perFile), ["W_LARGE_EMBED"]);
  assert.equal(perFile[0].path, "artifacts[0].embed");

  // Five embeds, each below the per-file bar, together over the bundle bar.
  const chunk = Math.floor(LINT_LIMITS.largeEmbed * 0.9);
  const artifacts = Array.from({ length: 5 }, (_, i) => ({
    ...textArtifact(`part-${i}.bin`, "x"),
    bytes: chunk,
  }));
  const bundle = lint(minimalBaton({ artifacts }));
  assert.deepEqual(codes(bundle), ["W_LARGE_BUNDLE"]);
  assert.equal(bundle[0].path, "artifacts");
});

test("created_at in the future warns, but small clock skew is tolerated", () => {
  const skewed = minimalBaton({ created_at: new Date(NOW + 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") });
  assert.deepEqual(lint(skewed), [], "one minute ahead is within skew");
  const future = minimalBaton({ created_at: "2030-01-01T00:00:00Z" });
  assert.deepEqual(codes(lint(future)), ["W_FUTURE_TIMESTAMP"]);
});
