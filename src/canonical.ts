/**
 * Canonical serialization and content-addressed identity.
 *
 * Two batons that mean the same thing must serialize to the same bytes,
 * regardless of the key order or whitespace of the JSON they were parsed
 * from. `canonicalize` rebuilds the document with a fixed field order per
 * object kind ("x-" extension keys are preserved, sorted, after the known
 * keys; `facts` keys are sorted); `batonDigest` hashes the compact
 * canonical form into a short stable id (`btn_` + 16 hex chars) that
 * diff, show and validate all print. Array order is meaningful in the
 * format (task order is presentation order), so arrays are never
 * reordered.
 */
import { sha256Hex } from "./digest.js";
import type { Baton } from "./types.js";

/** Field order per object kind; anything else in the format is a leaf. */
const FIELD_ORDER: Record<string, readonly string[]> = {
  baton: ["batonfile", "title", "created_at", "from", "summary", "tasks", "artifacts", "facts"],
  from: ["agent", "session", "label"],
  summary: ["goal", "state", "context", "decisions", "constraints"],
  decision: ["what", "why"],
  task: ["id", "title", "status", "priority", "blocked_by", "notes"],
  artifact: ["path", "role", "sha256", "bytes", "embed", "note"],
  embed: ["encoding", "content"],
};

/** Which kind each nested field is, so ordering recurses correctly. */
const CHILD_KIND: Record<string, string> = {
  "baton.from": "from",
  "baton.summary": "summary",
  "baton.tasks[]": "task",
  "baton.artifacts[]": "artifact",
  "summary.decisions[]": "decision",
  "artifact.embed": "embed",
};

function orderObject(value: unknown, kind: string): unknown {
  if (Array.isArray(value)) return value.map((v) => orderObject(v, kind));
  if (typeof value !== "object" || value === null) return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const known = FIELD_ORDER[kind] ?? [];

  for (const key of known) {
    if (!(key in obj)) continue;
    const childKind = CHILD_KIND[`${kind}.${key}[]`] ?? CHILD_KIND[`${kind}.${key}`];
    let child = obj[key];
    if (childKind !== undefined) {
      child = orderObject(child, childKind);
    } else if (key === "facts" && typeof child === "object" && child !== null && !Array.isArray(child)) {
      // facts is an open string map: sort its keys.
      const facts = child as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(facts).sort()) sorted[k] = facts[k];
      child = sorted;
    }
    out[key] = child;
  }

  // Extension keys ("x-…") ride along, sorted, after the known fields.
  // They are opaque: their inner key order is normalized alphabetically.
  const extras = Object.keys(obj)
    .filter((k) => !known.includes(k))
    .sort();
  for (const key of extras) out[key] = sortDeep(obj[key]);

  return out;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = sortDeep(obj[key]);
  return out;
}

/**
 * Serialize a baton in canonical form: fixed field order, two-space
 * indent, trailing newline. Writing this form means `git diff` on a
 * committed baton shows real changes, never key-order churn.
 */
export function canonicalize(baton: Baton): string {
  return JSON.stringify(orderObject(baton, "baton"), null, 2) + "\n";
}

/**
 * Content-addressed identity: sha256 over the compact canonical form,
 * shortened to `btn_` + 16 hex chars. Two batons with the same meaning get
 * the same digest even if their files differ in key order or whitespace.
 */
export function batonDigest(baton: Baton): string {
  const compact = JSON.stringify(orderObject(baton, "baton"));
  return "btn_" + sha256Hex(compact).slice(0, 16);
}
