// The validator is the contract of the interchange format: these tests pin
// the exact code and JSON path for every rule class — structural, referential
// (ids, blockers, cycles, duplicate paths) and integrity (digests, byte
// counts, encodings) — because downstream tooling keys off them.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateBaton } from "../dist/validate.js";
import { at, codes, minimalBaton, refArtifact, sha256, textArtifact } from "./helpers.mjs";

// -- structural ---------------------------------------------------------------

test("a minimal realistic baton validates with zero issues", () => {
  assert.deepEqual(validateBaton(minimalBaton()), []);
});

test("root must be a JSON object", () => {
  for (const doc of [null, [], "baton", 7]) {
    const issues = validateBaton(doc);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "E_TYPE");
    assert.equal(issues[0].path, "$");
  }
});

test("an unsupported format version short-circuits to a single E_VERSION", () => {
  // The rest of the document is garbage on purpose: findings against an
  // unknown schema would be noise, so only E_VERSION may be reported.
  const issues = validateBaton({ batonfile: "2", nonsense: true });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "E_VERSION");
  assert.match(issues[0].message, /batonfile\/1/);
});

test("all missing required top-level fields are reported together, in document order", () => {
  const issues = validateBaton({});
  assert.deepEqual(
    issues.map((i) => `${i.path}:${i.code}`),
    ["batonfile:E_REQUIRED", "title:E_REQUIRED", "created_at:E_REQUIRED", "summary:E_REQUIRED"]
  );
});

test("unknown keys are errors, but the x- extension prefix is allowed anywhere", () => {
  const doc = minimalBaton({ "x-batonfile-producer": { build: 7 }, extra: 1 });
  doc.summary["x-notes"] = "fine";
  const issues = validateBaton(doc);
  assert.deepEqual(codes(issues), ["E_UNKNOWN_KEY"]);
  assert.equal(issues[0].path, "extra");
});

test("created_at must be ISO-8601 UTC and a real instant", () => {
  const local = minimalBaton({ created_at: "2026-07-12 18:04:00" });
  assert.equal(at(validateBaton(local), "created_at")[0].code, "E_TIMESTAMP");
  const offset = minimalBaton({ created_at: "2026-07-12T18:04:00+09:00" });
  assert.equal(at(validateBaton(offset), "created_at")[0].code, "E_TIMESTAMP");
  // Matches the pattern but is not a date that exists.
  const impossible = minimalBaton({ created_at: "2026-02-30T00:00:00Z" });
  const issues = at(validateBaton(impossible), "created_at");
  assert.equal(issues[0].code, "E_TIMESTAMP");
  assert.match(issues[0].message, /not a real date/);
  const millis = minimalBaton({ created_at: "2026-07-12T18:04:00.123Z" });
  assert.deepEqual(validateBaton(millis), []);
});

test("string limits: over-long titles are E_LENGTH, whitespace-only goals are E_EMPTY", () => {
  const long = minimalBaton({ title: "x".repeat(201) });
  assert.equal(at(validateBaton(long), "title")[0].code, "E_LENGTH");
  const blank = minimalBaton();
  blank.summary = { goal: "   ", state: "fine so far, honestly" };
  assert.equal(at(validateBaton(blank), "summary.goal")[0].code, "E_EMPTY");
});

test("decisions must be objects with a non-empty what", () => {
  const doc = minimalBaton();
  doc.summary.decisions = ["not-an-object", { why: "reason without a what" }];
  const issues = validateBaton(doc);
  assert.equal(at(issues, "summary.decisions[0]")[0].code, "E_TYPE");
  assert.equal(at(issues, "summary.decisions[1].what")[0].code, "E_REQUIRED");
});

// -- tasks: ids, enums, references, cycles --------------------------------------

test("task ids must match the id pattern and be unique (duplicates name the first)", () => {
  const badIds = minimalBaton({
    tasks: [
      { id: "-starts-with-dash", title: "bad id", status: "open" },
      { id: "T".repeat(33), title: "too long", status: "open" },
      { id: "has space", title: "space", status: "open" },
    ],
  });
  assert.deepEqual(codes(validateBaton(badIds)), ["E_PATTERN", "E_PATTERN", "E_PATTERN"]);

  const dupes = minimalBaton({
    tasks: [
      { id: "T1", title: "first", status: "open" },
      { id: "T1", title: "second", status: "open" },
    ],
  });
  const issue = at(validateBaton(dupes), "tasks[1].id")[0];
  assert.equal(issue.code, "E_DUPLICATE");
  assert.match(issue.message, /tasks\[0\]/);
});

test("status and priority enums list the allowed values in the message", () => {
  const doc = minimalBaton({
    tasks: [{ id: "T1", title: "t", status: "paused", priority: "urgent" }],
  });
  const issues = validateBaton(doc);
  assert.equal(at(issues, "tasks[0].status")[0].code, "E_ENUM");
  assert.match(at(issues, "tasks[0].status")[0].message, /"in_progress"/);
  assert.equal(at(issues, "tasks[0].priority")[0].code, "E_ENUM");
});

test("blocked_by must reference existing, different tasks, each at most once", () => {
  const doc = minimalBaton({
    tasks: [
      { id: "T1", title: "a", status: "open", blocked_by: ["T9"] },
      { id: "T2", title: "b", status: "open", blocked_by: ["T2"] },
      { id: "T3", title: "c", status: "blocked", blocked_by: ["T1", "T1"] },
    ],
  });
  const issues = validateBaton(doc);
  assert.match(at(issues, "tasks[0].blocked_by[0]")[0].message, /unknown task id "T9"/);
  assert.match(at(issues, "tasks[1].blocked_by[0]")[0].message, /cannot block itself/);
  assert.equal(at(issues, "tasks[2].blocked_by[1]")[0].code, "E_DUPLICATE");
});

test("a two-task blocker cycle is reported once, with the full chain", () => {
  const doc = minimalBaton({
    tasks: [
      { id: "T1", title: "a", status: "open", blocked_by: ["T2"] },
      { id: "T2", title: "b", status: "open", blocked_by: ["T1"] },
    ],
  });
  const cycles = validateBaton(doc).filter((i) => i.code === "E_CYCLE");
  assert.equal(cycles.length, 1);
  assert.match(cycles[0].message, /T1 -> T2 -> T1|T2 -> T1 -> T2/);
});

test("a longer cycle is found, and a diamond dependency is not a cycle", () => {
  const cycle = minimalBaton({
    tasks: [
      { id: "A", title: "a", status: "open", blocked_by: ["B"] },
      { id: "B", title: "b", status: "open", blocked_by: ["C"] },
      { id: "C", title: "c", status: "open", blocked_by: ["A"] },
    ],
  });
  assert.equal(validateBaton(cycle).filter((i) => i.code === "E_CYCLE").length, 1);

  // A -> B, A -> C, B -> D, C -> D: shared ancestor, no cycle.
  const diamond = minimalBaton({
    tasks: [
      { id: "D", title: "d", status: "done" },
      { id: "B", title: "b", status: "open", blocked_by: ["D"] },
      { id: "C", title: "c", status: "open", blocked_by: ["D"] },
      { id: "A", title: "a", status: "open", blocked_by: ["B", "C"] },
    ],
  });
  assert.deepEqual(validateBaton(diamond), []);
});

// -- artifacts: paths, digests, encodings ---------------------------------------

test("artifact paths that could escape an unpack directory are rejected", () => {
  for (const path of ["../evil.txt", "/etc/passwd", "a/../../b", "C:evil", "a\\b", "a//b", "./a"]) {
    const doc = minimalBaton({ artifacts: [refArtifact(path, "x")] });
    const issues = at(validateBaton(doc), "artifacts[0].path");
    assert.equal(issues[0]?.code, "E_PATH", `expected E_PATH for ${JSON.stringify(path)}`);
  }
});

test("duplicate artifact paths are E_DUPLICATE", () => {
  const doc = minimalBaton({
    artifacts: [refArtifact("notes/a.md", "one"), refArtifact("notes/a.md", "two")],
  });
  assert.equal(at(validateBaton(doc), "artifacts[1].path")[0].code, "E_DUPLICATE");
});

test("sha256 and bytes are always required and well-formed, embed or not", () => {
  const malformed = minimalBaton({
    artifacts: [{ path: "a.txt", sha256: "ABC123", bytes: -1 }],
  });
  const issues = validateBaton(malformed);
  assert.equal(at(issues, "artifacts[0].sha256")[0].code, "E_PATTERN");
  assert.equal(at(issues, "artifacts[0].bytes")[0].code, "E_TYPE");

  const bare = minimalBaton({ artifacts: [{ path: "big/dataset.bin" }] });
  const bareIssues = validateBaton(bare);
  assert.ok(at(bareIssues, "artifacts[0].sha256").some((i) => i.code === "E_REQUIRED"));
  assert.ok(at(bareIssues, "artifacts[0].bytes").some((i) => i.code === "E_REQUIRED"));
});

test("embedded content must hash to the declared sha256", () => {
  const artifact = textArtifact("a.txt", "original content");
  artifact.embed.content = "tampered content!"; // same length, different bytes
  const doc = minimalBaton({ artifacts: [artifact] });
  const issue = at(validateBaton(doc), "artifacts[0].sha256")[0];
  assert.equal(issue.code, "E_DIGEST");
  assert.match(issue.message, /hashes to/);
});

test("embedded content must match the declared byte count", () => {
  const artifact = textArtifact("a.txt", "twelve bytes");
  artifact.bytes = 5;
  artifact.sha256 = sha256("twelve bytes"); // digest stays right: only bytes lies
  const doc = minimalBaton({ artifacts: [artifact] });
  const issue = at(validateBaton(doc), "artifacts[0].bytes")[0];
  assert.equal(issue.code, "E_BYTES");
  assert.match(issue.message, /12 bytes.*says 5/);
});

test("non-canonical base64 is E_ENCODING, not a digest mismatch", () => {
  const doc = minimalBaton({
    artifacts: [
      {
        path: "bin.dat",
        sha256: "0".repeat(64),
        bytes: 1,
        embed: { encoding: "base64", content: "not base64!!" },
      },
    ],
  });
  assert.equal(at(validateBaton(doc), "artifacts[0].embed.content")[0].code, "E_ENCODING");
});

test("a complete by-reference artifact (digest, no embed) is valid", () => {
  const ok = minimalBaton({ artifacts: [refArtifact("big/dataset.bin", "pretend")] });
  assert.deepEqual(validateBaton(ok), []);
});

// -- from and facts -------------------------------------------------------------

test("from requires agent; facts values must be strings", () => {
  const doc = minimalBaton({ from: { session: "s-1" }, facts: { port: 9402 } });
  const issues = validateBaton(doc);
  assert.ok(at(issues, "from.agent").some((i) => i.code === "E_REQUIRED"));
  assert.equal(at(issues, "facts.port")[0].code, "E_TYPE");
});
