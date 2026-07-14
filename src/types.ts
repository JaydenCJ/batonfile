/**
 * Type definitions for the batonfile/1 interchange format.
 *
 * A "baton" is a single, self-contained JSON document that one agent
 * session writes and the next one picks up: what we were doing, where it
 * stands, what is decided, what is left, and the files worth carrying
 * forward — each artifact identified by its SHA-256 digest and optionally
 * embedded so the receiver can reconstruct it byte-for-byte.
 *
 * The authoritative prose spec lives in docs/format.md; these types mirror
 * it exactly. Keys starting with "x-" are reserved extension points and are
 * ignored by the validator at every object level.
 */

/** Lifecycle of a handed-off task. */
export type TaskStatus = "open" | "in_progress" | "blocked" | "done";

/** Coarse urgency; `normal` is assumed when absent. */
export type TaskPriority = "high" | "normal" | "low";

/** What kind of file an artifact is, for the receiver's orientation. */
export type ArtifactRole = "code" | "config" | "doc" | "data" | "log" | "other";

/** How embedded artifact content is encoded inside the JSON document. */
export type EmbedEncoding = "utf8" | "base64";

/** A decision taken during the producing session, with optional rationale. */
export interface Decision {
  /** What was decided (e.g. "retry transient 5xx three times"). */
  what: string;
  /** Why — the reasoning the next session should not have to re-derive. */
  why?: string;
}

/** The structured conversation summary — the heart of the handoff. */
export interface Summary {
  /** What the work is ultimately trying to achieve. Required, non-empty. */
  goal: string;
  /** Where things stand right now. Required, non-empty. */
  state: string;
  /** Key facts the receiver needs (paths, commands, quirks). */
  context?: string[];
  /** Decisions already taken, so they are not relitigated. */
  decisions?: Decision[];
  /** Hard constraints the receiver must respect. */
  constraints?: string[];
}

/** One unit of open (or finished) work. */
export interface Task {
  /** Stable id, unique within the baton: `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`. */
  id: string;
  /** Imperative one-liner. Required, non-empty. */
  title: string;
  /** Lifecycle state. */
  status: TaskStatus;
  /** Urgency; treated as "normal" when absent. */
  priority?: TaskPriority;
  /** Ids of tasks this one waits on. Must reference existing ids, acyclic. */
  blocked_by?: string[];
  /** Free-form detail (repro steps, acceptance criteria). */
  notes?: string;
}

/** Embedded artifact content. */
export interface Embed {
  /** "utf8" for text, "base64" for binary. */
  encoding: EmbedEncoding;
  /** The content itself, encoded per `encoding`. */
  content: string;
}

/** A file worth carrying across the handoff boundary. */
export interface Artifact {
  /** Relative, forward-slash path — unique within the baton, no ".." or absolute paths. */
  path: string;
  /** Kind of file; treated as "other" when absent. */
  role?: ArtifactRole;
  /** Lowercase hex SHA-256 of the exact file bytes. Always required. */
  sha256: string;
  /** Exact byte length of the file. Always required. */
  bytes: number;
  /** Content, if embedded. Absent means "by reference": digest only. */
  embed?: Embed;
  /** Why this file matters to the receiver. */
  note?: string;
}

/** Who produced the baton. */
export interface From {
  /** Producing agent or tool name (e.g. "claude-code", "aider"). Required. */
  agent: string;
  /** Producer's session identifier, if it has one. */
  session?: string;
  /** Free-form label ("sprint 12 wrap-up"). */
  label?: string;
}

/** The complete batonfile/1 document. */
export interface Baton {
  /** Format major version. This build reads and writes "1". */
  batonfile: string;
  /** Human title of the handoff. Required, 1–200 chars. */
  title: string;
  /** ISO-8601 UTC instant with trailing "Z", e.g. "2026-07-12T18:04:00Z". */
  created_at: string;
  /** Producer identity. */
  from?: From;
  /** The structured summary. Required. */
  summary: Summary;
  /** Open and finished work items. */
  tasks?: Task[];
  /** Files carried across the boundary. */
  artifacts?: Artifact[];
  /** Flat string-to-string facts (branch names, service URLs, versions). */
  facts?: Record<string, string>;
}

/** Severity of a validator or lint finding. */
export type Severity = "error" | "warning";

/** One finding, anchored to a JSON path inside the document. */
export interface Issue {
  severity: Severity;
  /** Stable machine code, e.g. "E_DIGEST" or "W_THIN_GOAL". */
  code: string;
  /** JSON path such as "tasks[2].blocked_by[0]" ("$" is the document root). */
  path: string;
  /** Human explanation. */
  message: string;
}
