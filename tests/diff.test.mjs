// Diff answers "what changed since the last handoff?" — matching by task
// id, artifact path and fact key, with content changes decided by digest,
// not by embed representation. Both the structured result and the rendered
// text are pinned.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diffBatons, renderDiff } from "../dist/diff.js";
import { minimalBaton, refArtifact, textArtifact } from "./helpers.mjs";

test("identical batons diff as identical, by canonical digest", () => {
  const diff = diffBatons(minimalBaton(), minimalBaton());
  assert.equal(diff.identical, true);
  assert.equal(diff.oldDigest, diff.newDigest);
  assert.match(renderDiff(diff), /^identical \(btn_[0-9a-f]{16}\)$/);
});

test("tasks are matched by id: added, removed and changed are separated", () => {
  const before = minimalBaton({
    tasks: [
      { id: "T1", title: "keep me", status: "open" },
      { id: "T2", title: "remove me", status: "open" },
    ],
  });
  const after = minimalBaton({
    tasks: [
      { id: "T1", title: "keep me", status: "done" },
      { id: "T3", title: "new arrival", status: "open" },
    ],
  });
  const diff = diffBatons(before, after);
  assert.deepEqual(diff.tasksAdded.map((t) => t.id), ["T3"]);
  assert.deepEqual(diff.tasksRemoved.map((t) => t.id), ["T2"]);
  assert.deepEqual(diff.tasksChanged.map((c) => ({ id: c.id, fields: c.fields })), [
    { id: "T1", fields: ["status"] },
  ]);
});

test("absent priority equals explicit normal — no phantom change", () => {
  const before = minimalBaton({ tasks: [{ id: "T1", title: "t", status: "open" }] });
  const after = minimalBaton({ tasks: [{ id: "T1", title: "t", status: "open", priority: "normal" }] });
  const diff = diffBatons(before, after);
  assert.deepEqual(diff.tasksChanged, []);
});

test("artifact content changes are detected by sha256, not representation", () => {
  const before = minimalBaton({ artifacts: [textArtifact("a.txt", "version one")] });
  const changed = minimalBaton({ artifacts: [textArtifact("a.txt", "version two!")] });
  const diff = diffBatons(before, changed);
  assert.deepEqual(diff.artifactsChanged.map((c) => ({ path: c.path, kind: c.kind })), [
    { path: "a.txt", kind: "content" },
  ]);
  // Same bytes, embed dropped to by-reference: metadata change only.
  const dropped = minimalBaton({ artifacts: [refArtifact("a.txt", "version one")] });
  const metaDiff = diffBatons(before, dropped);
  assert.deepEqual(metaDiff.artifactsChanged.map((c) => c.kind), ["meta"]);
});

test("artifacts appear and disappear by path", () => {
  const before = minimalBaton({ artifacts: [textArtifact("old.txt", "x")] });
  const after = minimalBaton({ artifacts: [textArtifact("new.txt", "y")] });
  const diff = diffBatons(before, after);
  assert.deepEqual(diff.artifactsAdded.map((a) => a.path), ["new.txt"]);
  assert.deepEqual(diff.artifactsRemoved.map((a) => a.path), ["old.txt"]);
});

test("summary field changes and fact changes are reported by key", () => {
  const before = minimalBaton({ facts: { branch: "main", port: "9402" } });
  const after = minimalBaton({ facts: { branch: "fix/retry", region: "eu" } });
  after.summary = { ...after.summary, state: "All fifty verification runs passed." };
  const diff = diffBatons(before, after);
  assert.equal(diff.state.to, "All fifty verification runs passed.");
  assert.deepEqual(diff.factsChanged, ["branch", "port", "region"]);
});

test("renderDiff prints one line per change with +/-/~ prefixes", () => {
  const before = minimalBaton({
    tasks: [{ id: "T1", title: "apply the patch", status: "open" }],
    artifacts: [textArtifact("a.txt", "one")],
  });
  const after = minimalBaton({
    tasks: [
      { id: "T1", title: "apply the patch", status: "done" },
      { id: "T2", title: "verify the fix", status: "open" },
    ],
    artifacts: [textArtifact("a.txt", "two")],
  });
  const text = renderDiff(diffBatons(before, after));
  const lines = text.split("\n");
  assert.match(lines[0], /^btn_[0-9a-f]{16} -> btn_[0-9a-f]{16}$/);
  assert.ok(lines.includes('+ task T2 [open] "verify the fix"'));
  assert.ok(lines.some((l) => l.startsWith("~ task T1: status open -> done")));
  assert.ok(lines.some((l) => l.startsWith("~ artifact a.txt: content sha256 ")));
});

test("long values are flattened and truncated in rendered output", () => {
  const before = minimalBaton();
  const after = minimalBaton();
  after.summary = { ...after.summary, goal: ("multi\nline " + "x".repeat(100)).trim() };
  const text = renderDiff(diffBatons(before, after));
  assert.ok(!text.includes("multi\nline"), "newlines are flattened");
  assert.ok(text.includes("…"), "long values are truncated");
});
