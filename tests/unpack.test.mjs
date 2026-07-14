// Unpack is the only code that writes user-controlled paths to disk, so
// these tests focus on the safety property: nothing is written unless the
// whole baton checks out (paths inside the target, digests matching), and
// existing files survive unless force is given.
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeArtifact } from "../dist/pack.js";
import { UnpackError, unpackBaton } from "../dist/unpack.js";
import { minimalBaton, refArtifact, tempDir, textArtifact } from "./helpers.mjs";

test("embedded artifacts round-trip to disk byte-for-byte, creating directories", (t) => {
  const dir = tempDir(t);
  const binary = Buffer.from([0, 1, 2, 250, 251, 252]);
  const baton = minimalBaton({
    artifacts: [
      textArtifact("notes/deep/path/readme.md", "# hello\n"),
      makeArtifact("bin/blob.dat", binary),
    ],
  });
  const result = unpackBaton(baton, dir);
  assert.deepEqual(result.written.map((w) => w.path), ["notes/deep/path/readme.md", "bin/blob.dat"]);
  assert.equal(readFileSync(join(dir, "notes/deep/path/readme.md"), "utf8"), "# hello\n");
  assert.ok(readFileSync(join(dir, "bin/blob.dat")).equals(binary));
});

test("by-reference artifacts are reported as skipped, never invented", (t) => {
  const dir = tempDir(t);
  const baton = minimalBaton({ artifacts: [refArtifact("data/big.bin", "pretend")] });
  const result = unpackBaton(baton, dir);
  assert.deepEqual(result.written, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /by reference/);
  assert.ok(!existsSync(join(dir, "data/big.bin")));
});

test("a digest mismatch anywhere aborts before anything is written", (t) => {
  const dir = tempDir(t);
  const good = textArtifact("good.txt", "fine content");
  const bad = textArtifact("bad.txt", "original");
  bad.embed.content = "tampered!"; // digest now lies
  const baton = minimalBaton({ artifacts: [good, bad] });
  assert.throws(() => unpackBaton(baton, dir), UnpackError);
  assert.ok(!existsSync(join(dir, "good.txt")), "all-or-nothing: the good file must not be written either");
});

test("existing files are not overwritten unless force is set", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "a.txt"), "precious local edits");
  const baton = minimalBaton({ artifacts: [textArtifact("a.txt", "incoming")] });
  assert.throws(() => unpackBaton(baton, dir), /already exists/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "precious local edits");
  const result = unpackBaton(baton, dir, { force: true });
  assert.equal(result.written.length, 1);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "incoming");
});

test("hand-crafted traversal paths are refused even though validate would too", (t) => {
  const dir = tempDir(t);
  for (const path of ["../escape.txt", "/etc/nope", "a/../../b.txt"]) {
    const artifact = textArtifact(path, "malicious");
    const baton = minimalBaton({ artifacts: [artifact] });
    assert.throws(() => unpackBaton(baton, dir), UnpackError, `expected refusal for ${path}`);
  }
});

test("duplicate artifact paths are refused before anything is written", (t) => {
  // validateBaton rejects duplicates, but the public API must not rely on
  // the caller having validated: one write silently clobbering another
  // would make the "byte-for-byte" promise a lie.
  const dir = tempDir(t);
  const baton = minimalBaton({
    artifacts: [textArtifact("same.txt", "first version"), textArtifact("same.txt", "second version")],
  });
  assert.throws(() => unpackBaton(baton, dir), /duplicate artifact path "same.txt"/);
  assert.ok(!existsSync(join(dir, "same.txt")), "all-or-nothing: nothing may be written");
});

test("unpacking a baton with no artifacts is a clean no-op", (t) => {
  const dir = tempDir(t);
  const result = unpackBaton(minimalBaton({ artifacts: undefined }), dir);
  assert.deepEqual(result, { written: [], skipped: [] });
});
