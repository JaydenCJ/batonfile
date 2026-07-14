/**
 * Building batons: pure constructors plus the two markdown front doors.
 *
 * Sessions rarely end with structured data at hand — they end with a
 * summary written in markdown and a task list written as checkboxes. This
 * module turns both into the structured format:
 *
 *   - `parseSummaryMarkdown` reads `## Goal` / `## State` / `## Context` /
 *     `## Decisions` / `## Constraints` sections;
 *   - `parseTaskList` reads the GitHub task-list dialect, extended with
 *     `[~]` (in progress) and `[!]` (blocked), `(high)`/`(low)` priority
 *     suffixes and `(after T1, T2)` blocker references.
 *
 * Everything here is pure (no filesystem, no clock): callers inject file
 * contents and timestamps, which keeps packing reproducible and testable.
 */
import { encodeBuffer, sha256Hex } from "./digest.js";
import { unsafePathReason } from "./validate.js";
import { FORMAT_VERSION } from "./version.js";
import type { Artifact, ArtifactRole, Baton, Decision, From, Summary, Task, TaskPriority } from "./types.js";

/** Everything `createBaton` needs; only title, goal and state are mandatory. */
export interface CreateOptions {
  title: string;
  goal: string;
  state: string;
  createdAt: string;
  context?: string[];
  constraints?: string[];
  decisions?: Decision[];
  tasks?: Task[];
  artifacts?: Artifact[];
  facts?: Record<string, string>;
  from?: From;
}

/** Thrown on inputs that cannot become a baton (empty goal, bad path…). */
export class PackError extends Error {}

/** Assemble a baton document. Optional sections are omitted when empty. */
export function createBaton(opts: CreateOptions): Baton {
  if (opts.title.trim() === "") throw new PackError("title must not be empty");
  if (opts.goal.trim() === "") throw new PackError("summary goal must not be empty (use --goal or a ## Goal section)");
  if (opts.state.trim() === "") throw new PackError("summary state must not be empty (use --state or a ## State section)");

  const summary: Summary = { goal: opts.goal, state: opts.state };
  if (opts.context !== undefined && opts.context.length > 0) summary.context = opts.context;
  if (opts.decisions !== undefined && opts.decisions.length > 0) summary.decisions = opts.decisions;
  if (opts.constraints !== undefined && opts.constraints.length > 0) summary.constraints = opts.constraints;

  const baton: Baton = {
    batonfile: FORMAT_VERSION,
    title: opts.title,
    created_at: opts.createdAt,
    summary,
  };
  if (opts.from !== undefined) baton.from = opts.from;
  if (opts.tasks !== undefined && opts.tasks.length > 0) baton.tasks = opts.tasks;
  if (opts.artifacts !== undefined && opts.artifacts.length > 0) baton.artifacts = opts.artifacts;
  if (opts.facts !== undefined && Object.keys(opts.facts).length > 0) baton.facts = opts.facts;
  return baton;
}

/** Options for turning raw bytes into an artifact entry. */
export interface ArtifactOptions {
  role?: ArtifactRole;
  note?: string;
  /** Embed content when true (the default); false stores digest only. */
  embed?: boolean;
}

/**
 * Build an artifact from raw bytes. The digest and byte count are always
 * recorded; content is embedded unless `embed: false`.
 */
export function makeArtifact(relPath: string, data: Uint8Array, opts: ArtifactOptions = {}): Artifact {
  const reason = unsafePathReason(relPath);
  if (reason !== null) throw new PackError(`artifact path "${relPath}" ${reason}`);
  const artifact: Artifact = {
    path: relPath,
    sha256: sha256Hex(Buffer.from(data)),
    bytes: data.length,
  };
  if (opts.role !== undefined) artifact.role = opts.role;
  if (opts.embed !== false) artifact.embed = encodeBuffer(data);
  if (opts.note !== undefined && opts.note.trim() !== "") artifact.note = opts.note;
  return artifact;
}

// ---------------------------------------------------------------------------
// Markdown summary parser
// ---------------------------------------------------------------------------

/** parseSummaryMarkdown output: any section may be absent from the file. */
export interface ParsedSummary {
  goal?: string;
  state?: string;
  context: string[];
  decisions: Decision[];
  constraints: string[];
}

type SectionKey = "goal" | "state" | "context" | "decisions" | "constraints";

/** Heading aliases, so natural handoff notes parse without renaming headings. */
const SECTION_ALIASES: Record<string, SectionKey> = {
  "goal": "goal",
  "objective": "goal",
  "state": "state",
  "status": "state",
  "current state": "state",
  "where things stand": "state",
  "context": "context",
  "key facts": "context",
  "facts": "context",
  "decisions": "decisions",
  "decisions taken": "decisions",
  "constraints": "constraints",
  "hard constraints": "constraints",
};

const HEADING_RE = /^#{1,3}\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*]\s+(.+)$/;

/** Collapse a section's prose: lines join inside a paragraph, paragraphs join with a newline. */
function collapseProse(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) paragraphs.push(current.join(" "));
      current = [];
    } else {
      current.push(line.trim());
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

/** Extract bullet items; non-bullet lines continue the previous item. */
function collectBullets(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const m = BULLET_RE.exec(line);
    if (m !== null) {
      items.push((m[1] as string).trim());
    } else if (line.trim() !== "" && items.length > 0) {
      items[items.length - 1] += " " + line.trim();
    }
  }
  return items;
}

/** Split "what — why" (em dash, " -- ", or ": ") into a Decision. */
function parseDecision(text: string): Decision {
  for (const sep of [" — ", " -- ", ": "]) {
    const at = text.indexOf(sep);
    if (at > 0) {
      const why = text.slice(at + sep.length).trim();
      const decision: Decision = { what: text.slice(0, at).trim() };
      if (why !== "") decision.why = why;
      return decision;
    }
  }
  return { what: text };
}

/**
 * Parse a markdown handoff summary into structured sections. Content
 * before the first recognized heading and unrecognized sections are
 * ignored, so a summary can live inside a larger notes file.
 */
export function parseSummaryMarkdown(text: string): ParsedSummary {
  const result: ParsedSummary = { context: [], decisions: [], constraints: [] };
  const sections = new Map<SectionKey, string[]>();
  let current: SectionKey | null = null;

  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const key = SECTION_ALIASES[(heading[1] as string).trim().toLowerCase()];
      current = key ?? null;
      if (current !== null && !sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current !== null) (sections.get(current) as string[]).push(line);
  }

  const goal = sections.get("goal");
  if (goal !== undefined) {
    const prose = collapseProse(goal);
    if (prose !== "") result.goal = prose;
  }
  const state = sections.get("state");
  if (state !== undefined) {
    const prose = collapseProse(state);
    if (prose !== "") result.state = prose;
  }
  result.context = collectBullets(sections.get("context") ?? []);
  result.constraints = collectBullets(sections.get("constraints") ?? []);
  result.decisions = collectBullets(sections.get("decisions") ?? []).map(parseDecision);
  return result;
}

// ---------------------------------------------------------------------------
// Task-list parser
// ---------------------------------------------------------------------------

/** `- [<marker>] title` — the GitHub dialect plus `~` and `!`. */
const TASK_LINE_RE = /^\s*[-*]\s+\[([ xX~!])\]\s+(.+)$/;
/** Continuation: an indented non-bullet line becomes notes for the task above. */
const CONTINUATION_RE = /^\s{2,}(\S.*)$/;

const MARKER_STATUS: Record<string, Task["status"]> = {
  " ": "open",
  "x": "done",
  "X": "done",
  "~": "in_progress",
  "!": "blocked",
};

/** Trailing annotations: `(high)`, `(low)`, `(after T1, T2)` in any order. */
function stripAnnotations(title: string): { title: string; priority?: TaskPriority; after: string[] } {
  let rest = title.trim();
  let priority: TaskPriority | undefined;
  const after: string[] = [];
  const TRAILER_RE = /\s*\((high|low|after\s+[^)]+)\)\s*$/;

  for (;;) {
    const m = TRAILER_RE.exec(rest);
    if (m === null) break;
    const body = m[1] as string;
    if (body === "high" || body === "low") {
      priority = body;
    } else {
      for (const raw of body.replace(/^after\s+/, "").split(",")) {
        const token = raw.trim();
        if (token !== "") after.push(/^\d+$/.test(token) ? `T${token}` : token);
      }
    }
    rest = rest.slice(0, m.index).trim();
  }
  const out: { title: string; priority?: TaskPriority; after: string[] } = { title: rest, after };
  if (priority !== undefined) out.priority = priority;
  return out;
}

/**
 * Parse a markdown task list into tasks with sequential ids (T1, T2, …).
 * `startAt` continues numbering when combining a file with --task flags.
 * Lines that are not task bullets or continuations are ignored, so the
 * list can live inside a larger document.
 */
export function parseTaskList(text: string, startAt = 1): Task[] {
  const tasks: Task[] = [];
  let n = startAt;

  for (const line of text.split(/\r?\n/)) {
    const m = TASK_LINE_RE.exec(line);
    if (m !== null) {
      const status = MARKER_STATUS[m[1] as string] as Task["status"];
      const { title, priority, after } = stripAnnotations(m[2] as string);
      if (title === "") throw new PackError(`task on line "${line.trim()}" has no title`);
      const task: Task = { id: `T${n}`, title, status };
      if (priority !== undefined) task.priority = priority;
      if (after.length > 0) task.blocked_by = after;
      tasks.push(task);
      n += 1;
      continue;
    }
    const cont = CONTINUATION_RE.exec(line);
    if (cont !== null && tasks.length > 0) {
      const last = tasks[tasks.length - 1] as Task;
      last.notes = last.notes === undefined ? (cont[1] as string) : `${last.notes} ${cont[1] as string}`;
    }
  }
  return tasks;
}

/**
 * Parse a single `--task` flag value: an optional leading marker
 * (`x`/`~`/`!` followed by a space) then the same annotated title syntax
 * as the file dialect. `--task "! fix login (high)"` is a blocked,
 * high-priority task.
 */
export function parseTaskFlag(text: string, id: string): Task {
  let rest = text.trim();
  let status: Task["status"] = "open";
  const lead = /^([x~!])\s+/.exec(rest);
  if (lead !== null) {
    status = MARKER_STATUS[lead[1] as string] as Task["status"];
    rest = rest.slice(lead[0].length);
  }
  const { title, priority, after } = stripAnnotations(rest);
  if (title === "") throw new PackError(`--task "${text}" has no title`);
  const task: Task = { id, title, status };
  if (priority !== undefined) task.priority = priority;
  if (after.length > 0) task.blocked_by = after;
  return task;
}
