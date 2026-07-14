/**
 * Validator for the batonfile/1 interchange format.
 *
 * Three layers, all in one pass:
 *   1. structural  — shape, types, enums, patterns, length limits;
 *   2. referential — unique task ids, blocked_by references, cycle
 *                    detection, unique artifact paths, path safety;
 *   3. integrity   — embedded content must decode, match its declared
 *                    sha256 digest and its declared byte length.
 *
 * Pure: takes a parsed JSON value, returns issues in document order,
 * never touches the filesystem. Unknown keys are errors unless they start
 * with "x-" (the reserved extension prefix). A `batonfile` value other
 * than "1" short-circuits to a single E_VERSION error, because deeper
 * findings against an unknown schema would be noise.
 */
import { decodeEmbed, sha256Hex } from "./digest.js";
import { FORMAT_VERSION } from "./version.js";
import type { Issue } from "./types.js";

/** Size and pattern limits enforced by the validator (see docs/format.md). */
export const LIMITS = {
  /** Max length of the baton title. */
  title: 200,
  /** Max length of a task title. */
  taskTitle: 300,
  /** Max length of free-form notes / decision text / context items. */
  text: 4000,
  /** Max length of an artifact path. */
  path: 512,
  /** Max length of a facts key. */
  factKey: 128,
  /** Max length of a facts value. */
  factValue: 2000,
} as const;

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const TASK_STATUSES = ["open", "in_progress", "blocked", "done"] as const;
const TASK_PRIORITIES = ["high", "normal", "low"] as const;
const ARTIFACT_ROLES = ["code", "config", "doc", "data", "log", "other"] as const;
const EMBED_ENCODINGS = ["utf8", "base64"] as const;

function err(code: string, path: string, message: string): Issue {
  return { severity: "error", code, path, message };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

/**
 * Reject keys outside the allowed set, except the "x-" extension prefix.
 * Reports in the object's own key order for deterministic output.
 */
function checkKeys(
  obj: Record<string, unknown>,
  base: string,
  allowed: readonly string[],
  issues: Issue[]
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key) || key.startsWith("x-")) continue;
    const path = base === "" ? key : `${base}.${key}`;
    issues.push(err("E_UNKNOWN_KEY", path, `unknown key "${key}" (extensions must use the "x-" prefix)`));
  }
}

/**
 * Check a string field. Returns the value when it is a usable string, so
 * callers can chain content checks without re-narrowing.
 */
function checkString(
  value: unknown,
  path: string,
  issues: Issue[],
  opts: { required: boolean; min?: number; max?: number }
): string | undefined {
  if (value === undefined) {
    if (opts.required) issues.push(err("E_REQUIRED", path, "required field is missing"));
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push(err("E_TYPE", path, `must be a string, got ${describe(value)}`));
    return undefined;
  }
  const min = opts.min ?? 0;
  if (value.trim().length < min) {
    issues.push(err("E_EMPTY", path, "must not be empty"));
    return undefined;
  }
  if (opts.max !== undefined && value.length > opts.max) {
    issues.push(err("E_LENGTH", path, `is ${value.length} characters, max is ${opts.max}`));
  }
  return value;
}

function checkEnum(
  value: string,
  path: string,
  allowed: readonly string[],
  issues: Issue[]
): boolean {
  if (allowed.includes(value)) return true;
  issues.push(err("E_ENUM", path, `must be one of ${allowed.map((v) => `"${v}"`).join(", ")}, got "${value}"`));
  return false;
}

/**
 * Why a relative path is unsafe to store or extract, or null when it is
 * fine. Shared by the validator, `pack` (early rejection) and `unpack`
 * (defense in depth before writing to disk).
 */
export function unsafePathReason(p: string): string | null {
  if (p.length === 0) return "must not be empty";
  if (p.length > LIMITS.path) return `is ${p.length} characters, max is ${LIMITS.path}`;
  if (p.includes("\0")) return "must not contain NUL bytes";
  if (p.includes("\\")) return "must use forward slashes, not backslashes";
  if (p.startsWith("/")) return "must be relative, not absolute";
  if (/^[A-Za-z]:/.test(p)) return "must be relative, not a drive-letter path";
  for (const segment of p.split("/")) {
    if (segment === "") return "must not contain empty segments";
    if (segment === ".") return 'must not contain "." segments';
    if (segment === "..") return 'must not contain ".." segments';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

function validateFrom(value: unknown, issues: Issue[]): void {
  if (!isPlainObject(value)) {
    issues.push(err("E_TYPE", "from", `must be an object, got ${describe(value)}`));
    return;
  }
  checkKeys(value, "from", ["agent", "session", "label"], issues);
  checkString(value["agent"], "from.agent", issues, { required: true, min: 1, max: LIMITS.factKey });
  checkString(value["session"], "from.session", issues, { required: false, min: 1, max: LIMITS.factKey });
  checkString(value["label"], "from.label", issues, { required: false, min: 1, max: LIMITS.title });
}

function validateStringList(value: unknown, path: string, issues: Issue[]): void {
  if (!Array.isArray(value)) {
    issues.push(err("E_TYPE", path, `must be an array, got ${describe(value)}`));
    return;
  }
  value.forEach((item, i) => {
    checkString(item, `${path}[${i}]`, issues, { required: true, min: 1, max: LIMITS.text });
  });
}

function validateSummary(value: unknown, issues: Issue[]): void {
  if (value === undefined) {
    issues.push(err("E_REQUIRED", "summary", "required field is missing"));
    return;
  }
  if (!isPlainObject(value)) {
    issues.push(err("E_TYPE", "summary", `must be an object, got ${describe(value)}`));
    return;
  }
  checkKeys(value, "summary", ["goal", "state", "context", "decisions", "constraints"], issues);
  checkString(value["goal"], "summary.goal", issues, { required: true, min: 1, max: LIMITS.text });
  checkString(value["state"], "summary.state", issues, { required: true, min: 1, max: LIMITS.text });
  if (value["context"] !== undefined) validateStringList(value["context"], "summary.context", issues);
  if (value["constraints"] !== undefined) validateStringList(value["constraints"], "summary.constraints", issues);
  const decisions = value["decisions"];
  if (decisions !== undefined) {
    if (!Array.isArray(decisions)) {
      issues.push(err("E_TYPE", "summary.decisions", `must be an array, got ${describe(decisions)}`));
    } else {
      decisions.forEach((d, i) => {
        const path = `summary.decisions[${i}]`;
        if (!isPlainObject(d)) {
          issues.push(err("E_TYPE", path, `must be an object, got ${describe(d)}`));
          return;
        }
        checkKeys(d, path, ["what", "why"], issues);
        checkString(d["what"], `${path}.what`, issues, { required: true, min: 1, max: LIMITS.text });
        checkString(d["why"], `${path}.why`, issues, { required: false, min: 1, max: LIMITS.text });
      });
    }
  }
}

interface TaskShape {
  index: number;
  id: string;
  status: string | undefined;
  blockedBy: { ref: string; path: string }[];
}

function validateTasks(value: unknown, issues: Issue[]): void {
  if (!Array.isArray(value)) {
    issues.push(err("E_TYPE", "tasks", `must be an array, got ${describe(value)}`));
    return;
  }
  const shapes: TaskShape[] = [];
  const seenIds = new Map<string, number>();

  value.forEach((t, i) => {
    const path = `tasks[${i}]`;
    if (!isPlainObject(t)) {
      issues.push(err("E_TYPE", path, `must be an object, got ${describe(t)}`));
      return;
    }
    checkKeys(t, path, ["id", "title", "status", "priority", "blocked_by", "notes"], issues);

    const id = checkString(t["id"], `${path}.id`, issues, { required: true, min: 1 });
    if (id !== undefined) {
      if (!TASK_ID_RE.test(id)) {
        issues.push(err("E_PATTERN", `${path}.id`, `"${id}" must match ${TASK_ID_RE.source}`));
      } else if (seenIds.has(id)) {
        issues.push(err("E_DUPLICATE", `${path}.id`, `duplicate task id "${id}" (first used by tasks[${seenIds.get(id)}])`));
      } else {
        seenIds.set(id, i);
      }
    }

    checkString(t["title"], `${path}.title`, issues, { required: true, min: 1, max: LIMITS.taskTitle });

    const status = checkString(t["status"], `${path}.status`, issues, { required: true, min: 1 });
    if (status !== undefined) checkEnum(status, `${path}.status`, TASK_STATUSES, issues);

    const priority = checkString(t["priority"], `${path}.priority`, issues, { required: false, min: 1 });
    if (priority !== undefined) checkEnum(priority, `${path}.priority`, TASK_PRIORITIES, issues);

    checkString(t["notes"], `${path}.notes`, issues, { required: false, min: 1, max: LIMITS.text });

    const blockedBy: { ref: string; path: string }[] = [];
    const rawBlocked = t["blocked_by"];
    if (rawBlocked !== undefined) {
      if (!Array.isArray(rawBlocked)) {
        issues.push(err("E_TYPE", `${path}.blocked_by`, `must be an array, got ${describe(rawBlocked)}`));
      } else {
        rawBlocked.forEach((ref, j) => {
          const refPath = `${path}.blocked_by[${j}]`;
          const refId = checkString(ref, refPath, issues, { required: true, min: 1 });
          if (refId !== undefined) blockedBy.push({ ref: refId, path: refPath });
        });
      }
    }
    if (id !== undefined) {
      shapes.push({ index: i, id, status, blockedBy });
    }
  });

  // Referential checks: every blocker must name an existing, different task.
  const validIds = new Set(shapes.map((s) => s.id));
  for (const shape of shapes) {
    const seenRefs = new Set<string>();
    for (const { ref, path } of shape.blockedBy) {
      if (ref === shape.id) {
        issues.push(err("E_REF", path, `task "${shape.id}" cannot block itself`));
      } else if (!validIds.has(ref)) {
        issues.push(err("E_REF", path, `unknown task id "${ref}"`));
      } else if (seenRefs.has(ref)) {
        issues.push(err("E_DUPLICATE", path, `duplicate blocker "${ref}"`));
      }
      seenRefs.add(ref);
    }
  }

  findBlockerCycles(shapes, issues);
}

/**
 * Depth-first search over the blocked_by graph. Each back edge is reported
 * once as an E_CYCLE, with the full cycle spelled out so the user does not
 * have to reconstruct it. Deterministic: tasks are visited in document
 * order, edges in declaration order.
 */
function findBlockerCycles(shapes: TaskShape[], issues: Issue[]): void {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(shape: TaskShape): void {
    state.set(shape.id, "visiting");
    stack.push(shape.id);
    for (const { ref, path } of shape.blockedBy) {
      const target = byId.get(ref);
      if (target === undefined || ref === shape.id) continue; // already E_REF'd
      const s = state.get(ref);
      if (s === "visiting") {
        const cycle = stack.slice(stack.indexOf(ref)).concat(ref);
        issues.push(err("E_CYCLE", path, `blocked_by cycle: ${cycle.join(" -> ")}`));
      } else if (s === undefined) {
        visit(target);
      }
    }
    stack.pop();
    state.set(shape.id, "done");
  }

  for (const shape of shapes) {
    if (!state.has(shape.id)) visit(shape);
  }
}

function validateArtifacts(value: unknown, issues: Issue[]): void {
  if (!Array.isArray(value)) {
    issues.push(err("E_TYPE", "artifacts", `must be an array, got ${describe(value)}`));
    return;
  }
  const seenPaths = new Map<string, number>();

  value.forEach((a, i) => {
    const path = `artifacts[${i}]`;
    if (!isPlainObject(a)) {
      issues.push(err("E_TYPE", path, `must be an object, got ${describe(a)}`));
      return;
    }
    checkKeys(a, path, ["path", "role", "sha256", "bytes", "embed", "note"], issues);

    const relPath = checkString(a["path"], `${path}.path`, issues, { required: true, min: 1 });
    if (relPath !== undefined) {
      const reason = unsafePathReason(relPath);
      if (reason !== null) {
        issues.push(err("E_PATH", `${path}.path`, `"${relPath}" ${reason}`));
      } else if (seenPaths.has(relPath)) {
        issues.push(err("E_DUPLICATE", `${path}.path`, `duplicate artifact path "${relPath}" (first used by artifacts[${seenPaths.get(relPath)}])`));
      } else {
        seenPaths.set(relPath, i);
      }
    }

    const role = checkString(a["role"], `${path}.role`, issues, { required: false, min: 1 });
    if (role !== undefined) checkEnum(role, `${path}.role`, ARTIFACT_ROLES, issues);

    checkString(a["note"], `${path}.note`, issues, { required: false, min: 1, max: LIMITS.text });

    const sha = checkString(a["sha256"], `${path}.sha256`, issues, { required: true, min: 1 });
    if (sha !== undefined && !SHA256_RE.test(sha)) {
      issues.push(err("E_PATTERN", `${path}.sha256`, "must be 64 lowercase hex characters"));
    }

    const bytes = a["bytes"];
    let declaredBytes: number | undefined;
    if (bytes === undefined) {
      issues.push(err("E_REQUIRED", `${path}.bytes`, "required field is missing"));
    } else if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
      issues.push(err("E_TYPE", `${path}.bytes`, `must be a non-negative integer, got ${JSON.stringify(bytes)}`));
    } else {
      declaredBytes = bytes;
    }

    const embed = a["embed"];
    if (embed === undefined) return;
    if (!isPlainObject(embed)) {
      issues.push(err("E_TYPE", `${path}.embed`, `must be an object, got ${describe(embed)}`));
      return;
    }
    checkKeys(embed, `${path}.embed`, ["encoding", "content"], issues);
    const encoding = checkString(embed["encoding"], `${path}.embed.encoding`, issues, { required: true, min: 1 });
    const content = embed["content"];
    if (content === undefined) {
      issues.push(err("E_REQUIRED", `${path}.embed.content`, "required field is missing"));
      return;
    }
    if (typeof content !== "string") {
      issues.push(err("E_TYPE", `${path}.embed.content`, `must be a string, got ${describe(content)}`));
      return;
    }
    if (encoding === undefined || !checkEnum(encoding, `${path}.embed.encoding`, EMBED_ENCODINGS, issues)) return;

    // Integrity: decode, then confirm both declared bytes and declared digest.
    let decoded: Buffer;
    try {
      decoded = decodeEmbed({ encoding: encoding as "utf8" | "base64", content });
    } catch (e) {
      issues.push(err("E_ENCODING", `${path}.embed.content`, (e as Error).message));
      return;
    }
    if (declaredBytes !== undefined && decoded.length !== declaredBytes) {
      issues.push(err("E_BYTES", `${path}.bytes`, `embedded content is ${decoded.length} bytes but "bytes" says ${declaredBytes}`));
    }
    if (sha !== undefined && SHA256_RE.test(sha)) {
      const actual = sha256Hex(decoded);
      if (actual !== sha) {
        issues.push(err("E_DIGEST", `${path}.sha256`, `embedded content hashes to ${actual.slice(0, 12)}…, not the declared ${sha.slice(0, 12)}…`));
      }
    }
  });
}

function validateFacts(value: unknown, issues: Issue[]): void {
  if (!isPlainObject(value)) {
    issues.push(err("E_TYPE", "facts", `must be an object, got ${describe(value)}`));
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    const path = `facts.${key}`;
    if (key.length === 0) {
      issues.push(err("E_EMPTY", "facts", "fact keys must not be empty"));
      continue;
    }
    if (key.length > LIMITS.factKey) {
      issues.push(err("E_LENGTH", path, `key is ${key.length} characters, max is ${LIMITS.factKey}`));
    }
    if (typeof val !== "string") {
      issues.push(err("E_TYPE", path, `must be a string, got ${describe(val)}`));
    } else if (val.length > LIMITS.factValue) {
      issues.push(err("E_LENGTH", path, `value is ${val.length} characters, max is ${LIMITS.factValue}`));
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON value against batonfile/1. Returns all findings
 * (errors only — quality warnings live in lint.ts); an empty array means
 * the document is a valid baton.
 */
export function validateBaton(doc: unknown): Issue[] {
  if (!isPlainObject(doc)) {
    return [err("E_TYPE", "$", `baton must be a JSON object, got ${describe(doc)}`)];
  }

  const issues: Issue[] = [];
  const version = doc["batonfile"];
  if (version === undefined) {
    issues.push(err("E_REQUIRED", "batonfile", 'required field is missing (expected "batonfile": "1")'));
  } else if (typeof version !== "string") {
    issues.push(err("E_TYPE", "batonfile", `must be a string, got ${describe(version)}`));
  } else if (version !== FORMAT_VERSION) {
    // Unknown major version: deeper findings would be judged against the
    // wrong schema, so report only this.
    return [err("E_VERSION", "batonfile", `unsupported format version "${version}" (this build reads batonfile/${FORMAT_VERSION})`)];
  }

  checkKeys(doc, "", ["batonfile", "title", "created_at", "from", "summary", "tasks", "artifacts", "facts"], issues);

  checkString(doc["title"], "title", issues, { required: true, min: 1, max: LIMITS.title });

  const createdAt = checkString(doc["created_at"], "created_at", issues, { required: true, min: 1 });
  if (createdAt !== undefined) {
    if (!TIMESTAMP_RE.test(createdAt)) {
      issues.push(err("E_TIMESTAMP", "created_at", `"${createdAt}" must be an ISO-8601 UTC instant like "2026-07-12T18:04:00Z"`));
    } else {
      // Date.parse rolls impossible dates over (Feb 30 -> Mar 2), so
      // round-trip the date part to catch instants that do not exist.
      const parsed = Date.parse(createdAt);
      if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== createdAt.slice(0, 10)) {
        issues.push(err("E_TIMESTAMP", "created_at", `"${createdAt}" is not a real date`));
      }
    }
  }

  if (doc["from"] !== undefined) validateFrom(doc["from"], issues);
  validateSummary(doc["summary"], issues);
  if (doc["tasks"] !== undefined) validateTasks(doc["tasks"], issues);
  if (doc["artifacts"] !== undefined) validateArtifacts(doc["artifacts"], issues);
  if (doc["facts"] !== undefined) validateFacts(doc["facts"], issues);

  return issues;
}
