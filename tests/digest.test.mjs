// Hashing and embed encoding are the integrity layer of the format: these
// tests pin known SHA-256 vectors, the text-vs-binary embedding decision,
// and the strictness of decoding (nothing that cannot round-trip may pass).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decodeEmbed, encodeBuffer, formatBytes, isEmbeddableText, sha256Hex } from "../dist/digest.js";

test("sha256Hex matches the published test vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("clean text (including UTF-8 beyond ASCII) embeds as utf8", () => {
  const embed = encodeBuffer(Buffer.from("diff --git a/b\n+日本語 résumé\n", "utf8"));
  assert.equal(embed.encoding, "utf8");
  assert.match(embed.content, /日本語/);
});

test("binary content (NUL, control bytes, invalid UTF-8) embeds as base64", () => {
  for (const bytes of [[0x00], [0x1b, 0x5b], [0xff, 0xfe], [0x7f]]) {
    const buf = Buffer.from(bytes);
    assert.equal(isEmbeddableText(buf), false, `bytes ${bytes} should not be text`);
    assert.equal(encodeBuffer(buf).encoding, "base64");
  }
  // Tab, newline and carriage return are still text.
  assert.equal(isEmbeddableText(Buffer.from("a\tb\r\nc")), true);
});

test("encode/decode round-trips binary byte-for-byte", () => {
  const original = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const decoded = decodeEmbed(encodeBuffer(original));
  assert.ok(decoded.equals(original));
});

test("decodeEmbed is strict: non-canonical base64 and non-round-tripping utf8 are refused", () => {
  for (const content of ["A", "ab", "####", "abcd==ef", "abc=="]) {
    assert.throws(() => decodeEmbed({ encoding: "base64", content }), /canonical base64/);
  }
  // A lone surrogate survives JSON but not a UTF-8 round trip.
  assert.throws(() => decodeEmbed({ encoding: "utf8", content: "broken \ud800 here" }), /round trip/);
});

test("formatBytes picks sensible units at the boundaries", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(745), "745 B");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MiB");
});
