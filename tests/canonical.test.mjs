// Canonicalization is what makes a baton diffable and content-addressable:
// the same meaning must always serialize to the same bytes, and the digest
// must ignore exactly the things that do not matter (key order, whitespace)
// while tracking everything that does (values, array order).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { batonDigest, canonicalize } from "../dist/canonical.js";
import { minimalBaton, textArtifact } from "./helpers.mjs";

/** Rebuild an object with reversed key order at every level. */
function scramble(value) {
  if (Array.isArray(value)) return value.map(scramble);
  if (typeof value !== "object" || value === null) return value;
  const out = {};
  for (const key of Object.keys(value).reverse()) out[key] = scramble(value[key]);
  return out;
}

test("canonicalize emits the fixed field order regardless of input order", () => {
  const baton = minimalBaton({
    artifacts: [textArtifact("a.txt", "hello", { role: "doc" })],
    facts: { zeta: "1", alpha: "2" },
  });
  const text = canonicalize(scramble(baton));
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc), ["batonfile", "title", "created_at", "summary", "tasks", "artifacts", "facts"]);
  assert.deepEqual(Object.keys(doc.artifacts[0]), ["path", "role", "sha256", "bytes", "embed"]);
  assert.deepEqual(Object.keys(doc.facts), ["alpha", "zeta"], "facts keys are sorted");
});

test("canonical output is two-space indented and ends with one newline", () => {
  const text = canonicalize(minimalBaton());
  assert.match(text, /^\{\n  "batonfile": "1",\n/);
  assert.ok(text.endsWith("}\n"));
  assert.ok(!text.endsWith("\n\n"));
});

test("x- extension keys survive canonicalization, sorted after known keys", () => {
  const baton = minimalBaton({ "x-zeta": 1, "x-alpha": { b: 2, a: 1 } });
  const doc = JSON.parse(canonicalize(baton));
  const keys = Object.keys(doc);
  assert.deepEqual(keys.slice(-2), ["x-alpha", "x-zeta"]);
  assert.deepEqual(Object.keys(doc["x-alpha"]), ["a", "b"], "extension internals are sorted deep");
});

test("batonDigest is invariant under key order and whitespace, with a stable shape", () => {
  const baton = minimalBaton({ facts: { branch: "main", port: "9402" } });
  assert.match(batonDigest(baton), /^btn_[0-9a-f]{16}$/);
  assert.equal(batonDigest(baton), batonDigest(scramble(baton)));
  // Round-tripping through pretty JSON changes nothing either.
  const reparsed = JSON.parse(canonicalize(baton));
  assert.equal(batonDigest(baton), batonDigest(reparsed));
});

test("batonDigest changes when meaning changes", () => {
  const before = minimalBaton();
  const after = minimalBaton();
  after.tasks = [{ ...after.tasks[0], status: "done" }];
  assert.notEqual(batonDigest(before), batonDigest(after));
});

test("array order is meaning: swapping two tasks changes the digest", () => {
  const a = minimalBaton({
    tasks: [
      { id: "T1", title: "first", status: "open" },
      { id: "T2", title: "second", status: "open" },
    ],
  });
  const b = minimalBaton({ tasks: [a.tasks[1], a.tasks[0]] });
  assert.notEqual(batonDigest(a), batonDigest(b));
});
