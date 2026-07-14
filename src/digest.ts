/**
 * Content hashing and embed encoding/decoding.
 *
 * Every artifact in a baton is identified by the SHA-256 of its exact
 * bytes; embedded content is stored as UTF-8 text when it safely round-trips
 * through a JSON string, and as base64 otherwise. Both directions are
 * strict: decoding rejects non-canonical base64 and strings that do not
 * survive a UTF-8 round trip, so a digest can always be recomputed.
 */
import { createHash } from "node:crypto";
import type { Embed } from "./types.js";

/** Lowercase hex SHA-256 of a buffer or UTF-8 string. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Matches only canonical base64 (standard alphabet, correct padding). */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * True when the buffer can be embedded as a JSON UTF-8 string without loss:
 * it must round-trip exactly and contain no NUL or C0 control characters
 * other than tab, newline and carriage return. Anything else is binary
 * enough to deserve base64.
 */
export function isEmbeddableText(buf: Uint8Array): boolean {
  const asBuffer = Buffer.from(buf);
  const text = asBuffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(asBuffer)) return false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return false;
    if (cp === 0x7f) return false;
  }
  return true;
}

/** Encode raw bytes as an embed, choosing utf8 for clean text, else base64. */
export function encodeBuffer(buf: Uint8Array): Embed {
  if (isEmbeddableText(buf)) {
    return { encoding: "utf8", content: Buffer.from(buf).toString("utf8") };
  }
  return { encoding: "base64", content: Buffer.from(buf).toString("base64") };
}

/** Thrown when embedded content cannot be decoded back to bytes. */
export class EmbedError extends Error {}

/**
 * Decode an embed back to the exact original bytes. Throws EmbedError on
 * non-canonical base64 or on utf8 content that does not round-trip (for
 * example lone surrogates smuggled through JSON).
 */
export function decodeEmbed(embed: Embed): Buffer {
  if (embed.encoding === "base64") {
    if (!BASE64_RE.test(embed.content)) {
      throw new EmbedError("content is not canonical base64");
    }
    return Buffer.from(embed.content, "base64");
  }
  const buf = Buffer.from(embed.content, "utf8");
  if (buf.toString("utf8") !== embed.content) {
    throw new EmbedError("content does not survive a UTF-8 round trip");
  }
  return buf;
}

/** "1.2 KiB"-style human size used by `show`, `unpack` and pack status lines. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
