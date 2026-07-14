// Packing is the producer side: pure baton construction plus the two
// markdown front doors (summary sections, task lists). The parsers face
// real-world notes, so the edge cases here — aliases, continuations,
// annotations, content outside recognized sections — are the point.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PackError,
  createBaton,
  makeArtifact,
  parseSummaryMarkdown,
  parseTaskFlag,
  parseTaskList,
} from "../dist/pack.js";
import { validateBaton } from "../dist/validate.js";
import { sha256, WHEN } from "./helpers.mjs";

// -- createBaton ----------------------------------------------------------------

test("createBaton omits empty optional sections and refuses empty required ones", () => {
  const baton = createBaton({ title: "t", goal: "the goal", state: "the state", createdAt: WHEN, context: [], tasks: [], facts: {} });
  assert.deepEqual(Object.keys(baton), ["batonfile", "title", "created_at", "summary"]);
  assert.deepEqual(Object.keys(baton.summary), ["goal", "state"]);
  assert.throws(() => createBaton({ title: " ", goal: "g", state: "s", createdAt: WHEN }), PackError);
  assert.throws(() => createBaton({ title: "t", goal: "", state: "s", createdAt: WHEN }), /goal/);
  assert.throws(() => createBaton({ title: "t", goal: "g", state: "  ", createdAt: WHEN }), /state/);
});

test("createBaton output always validates", () => {
  const baton = createBaton({
    title: "Fix the flaky checkout test",
    goal: "Make the suite reliable",
    state: "Patch drafted",
    createdAt: WHEN,
    context: ["stub binds 127.0.0.1:9402"],
    constraints: ["do not raise timeouts"],
    decisions: [{ what: "fix the client", why: "the test is fine" }],
    tasks: [{ id: "T1", title: "apply patch", status: "open" }],
    facts: { branch: "fix/retry" },
    from: { agent: "claude-code", session: "s-1" },
  });
  assert.deepEqual(validateBaton(baton), []);
});

// -- makeArtifact -----------------------------------------------------------------

test("makeArtifact records the real digest and byte count; embed:false keeps it by reference", () => {
  const artifact = makeArtifact("notes/a.md", Buffer.from("hello baton"), { role: "doc" });
  assert.equal(artifact.sha256, sha256("hello baton"));
  assert.equal(artifact.bytes, 11);
  assert.equal(artifact.embed.encoding, "utf8");
  assert.equal(artifact.embed.content, "hello baton");

  const reference = makeArtifact("big.bin", Buffer.from([0, 1, 2]), { embed: false });
  assert.equal(reference.embed, undefined);
  assert.equal(reference.bytes, 3);
});

test("makeArtifact rejects unsafe paths up front", () => {
  assert.throws(() => makeArtifact("../escape.txt", Buffer.from("x")), PackError);
  assert.throws(() => makeArtifact("/abs.txt", Buffer.from("x")), /relative/);
});

// -- parseSummaryMarkdown ----------------------------------------------------------

const SUMMARY_MD = `# Handoff

Ignore this preamble entirely.

## Goal

Make the checkout test pass
reliably on every run.

Second paragraph of the goal.

## Where things stand

Root cause found; patch drafted.

## Context

- stub binds 127.0.0.1:9402
- run with npm run test:integration
  -- --grep checkout

## Decisions

- fix the client, not the test — sleeps only hide the race
- three retry attempts: bounded latency

## Constraints

- do not raise the global timeout

## Random section

- this is not part of the summary
`;

test("parseSummaryMarkdown extracts every recognized section", () => {
  const parsed = parseSummaryMarkdown(SUMMARY_MD);
  assert.equal(parsed.goal, "Make the checkout test pass reliably on every run.\nSecond paragraph of the goal.");
  assert.equal(parsed.state, "Root cause found; patch drafted.");
  assert.deepEqual(parsed.constraints, ["do not raise the global timeout"]);
});

test("bullet continuation lines join the bullet above", () => {
  const parsed = parseSummaryMarkdown(SUMMARY_MD);
  assert.deepEqual(parsed.context, [
    "stub binds 127.0.0.1:9402",
    "run with npm run test:integration -- --grep checkout",
  ]);
});

test("decisions split what from why on em-dash or colon; why is optional", () => {
  const parsed = parseSummaryMarkdown(SUMMARY_MD);
  assert.deepEqual(parsed.decisions, [
    { what: "fix the client, not the test", why: "sleeps only hide the race" },
    { what: "three retry attempts", why: "bounded latency" },
  ]);
  assert.deepEqual(parseSummaryMarkdown("## Decisions\n- keep it simple\n").decisions, [{ what: "keep it simple" }]);
});

test("heading aliases map onto goal and state; unrecognized content is ignored", () => {
  const md = "free preamble\n\n## Objective\n\nShip it.\n\n## Status\n\nAlmost there.\n\n## Weather\n\n- sunny\n";
  const parsed = parseSummaryMarkdown(md);
  assert.equal(parsed.goal, "Ship it.");
  assert.equal(parsed.state, "Almost there.");
  assert.deepEqual(parsed.context, [], "unknown sections contribute nothing");
});

// -- parseTaskList -----------------------------------------------------------------

test("the four markers map to the four statuses", () => {
  const tasks = parseTaskList("- [ ] open one\n- [x] done one\n- [~] busy one\n- [!] stuck one\n");
  assert.deepEqual(tasks.map((t) => t.status), ["open", "done", "in_progress", "blocked"]);
  assert.deepEqual(tasks.map((t) => t.id), ["T1", "T2", "T3", "T4"]);
});

test("priority and (after …) annotations are stripped from the title", () => {
  const tasks = parseTaskList("- [ ] deploy the fix (high) (after T1, 2)\n- [ ] tidy up (low)\n");
  assert.equal(tasks[0].title, "deploy the fix");
  assert.equal(tasks[0].priority, "high");
  assert.deepEqual(tasks[0].blocked_by, ["T1", "T2"], "bare numbers resolve to T-ids");
  assert.equal(tasks[1].priority, "low");
});

test("indented continuation lines become notes; other lines are ignored", () => {
  const tasks = parseTaskList("# Open work\n\n- [!] ask for deploy access\n  needs someone with credentials\n  outside this repo\nplain paragraph, not indented\n");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].notes, "needs someone with credentials outside this repo");
});

test("startAt continues numbering so files and flags can be combined", () => {
  const tasks = parseTaskList("- [ ] later task\n", 4);
  assert.equal(tasks[0].id, "T4");
});

test("a parsed task list validates as part of a baton (referential integrity)", () => {
  const tasks = parseTaskList("- [x] find the bug\n- [ ] fix it (after 1)\n");
  const issues = validateBaton({
    batonfile: "1",
    title: "t",
    created_at: WHEN,
    summary: { goal: "a real goal here", state: "a real state here" },
    tasks,
  });
  assert.deepEqual(issues, []);
});

// -- parseTaskFlag -----------------------------------------------------------------

test("--task flag syntax: optional leading marker, annotations, and no empty titles", () => {
  assert.deepEqual(parseTaskFlag("plain open task", "T1"), { id: "T1", title: "plain open task", status: "open" });
  assert.deepEqual(parseTaskFlag("x already finished", "T2"), { id: "T2", title: "already finished", status: "done" });
  const blocked = parseTaskFlag("! wait on creds (high)", "T3");
  assert.deepEqual(blocked, { id: "T3", title: "wait on creds", status: "blocked", priority: "high" });
  assert.throws(() => parseTaskFlag("x (high)", "T1"), PackError, "annotations alone are not a title");
});
