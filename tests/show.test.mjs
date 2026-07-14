// The briefing is what a receiving agent actually reads, so its shape is
// contract too: header metadata, section order, task markers that
// round-trip through the pack parser, and no empty sections.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { batonDigest } from "../dist/canonical.js";
import { parseTaskList } from "../dist/pack.js";
import { renderBriefing } from "../dist/show.js";
import { minimalBaton, refArtifact, textArtifact } from "./helpers.mjs";

test("briefing header carries title, digest, format, producer and timestamp", () => {
  const baton = minimalBaton({ from: { agent: "claude-code", session: "s-0712" } });
  const text = renderBriefing(baton);
  const lines = text.split("\n");
  assert.equal(lines[0], "# Baton: Fix the flaky checkout integration test");
  assert.ok(lines[1].includes(batonDigest(baton)));
  assert.ok(lines[1].includes("batonfile/1"));
  assert.ok(lines[1].includes("from claude-code (session s-0712)"));
  assert.ok(lines[1].includes("2026-07-12T18:04:00Z"));
});

test("tasks render with round-trippable markers and a status count line", () => {
  const baton = minimalBaton({
    tasks: [
      { id: "T1", title: "done thing", status: "done" },
      { id: "T2", title: "busy thing", status: "in_progress", priority: "high" },
      { id: "T3", title: "stuck thing", status: "blocked", blocked_by: ["T2"] },
    ],
  });
  const text = renderBriefing(baton);
  assert.ok(text.includes("## Tasks (1 in progress · 1 blocked · 1 done)"));
  assert.ok(text.includes("- [x] T1 · done thing"));
  assert.ok(text.includes("- [~] T2 · high · busy thing"));
  assert.ok(text.includes("- [!] T3 · stuck thing · (after T2)"));
  // The rendered list parses back with the same statuses (format round-trip).
  const reparsed = parseTaskList(text);
  assert.deepEqual(reparsed.map((t) => t.status), ["done", "in_progress", "blocked"]);
});

test("artifacts show size, embedding mode and a shortened digest", () => {
  const baton = minimalBaton({
    artifacts: [
      textArtifact("patch/fix.diff", "small patch body", { role: "code" }),
      refArtifact("data/big.bin", "pretend", { role: "data" }),
    ],
  });
  const text = renderBriefing(baton);
  assert.ok(text.includes("## Artifacts (1 embedded · 1 by reference, 16 B carried)"));
  assert.ok(text.includes("- patch/fix.diff · code · 16 B · embedded · sha256 "));
  assert.ok(text.includes("- data/big.bin · data · 7 B · by reference · sha256 "));
});

test("optional sections are omitted, not rendered empty", () => {
  const text = renderBriefing(minimalBaton());
  for (const heading of ["## Context", "## Decisions", "## Constraints", "## Artifacts", "## Facts"]) {
    assert.ok(!text.includes(heading), `${heading} should be absent`);
  }
  assert.ok(text.endsWith("\n"));
  assert.ok(!text.endsWith("\n\n"), "no trailing blank lines");
});

test("rendering is deterministic and facts are sorted by key", () => {
  const baton = minimalBaton({ facts: { zeta: "last", alpha: "first" } });
  const one = renderBriefing(baton);
  assert.equal(one, renderBriefing(baton));
  assert.ok(one.indexOf("alpha: first") < one.indexOf("zeta: last"));
});
