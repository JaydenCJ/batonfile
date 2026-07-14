/**
 * Structural diff between two batons — the question is always "what
 * changed since the last handoff?". Tasks are matched by id, artifacts by
 * path, facts by key; the summary is compared field by field. Content
 * changes in artifacts are detected by sha256, so a re-encoded but
 * byte-identical embed is not a change.
 */
import { batonDigest } from "./canonical.js";
import type { Artifact, Baton, Task } from "./types.js";

export interface FieldChange {
  from: string;
  to: string;
}

export interface TaskChange {
  id: string;
  /** Which task fields differ: "title" | "status" | "priority" | "blocked_by" | "notes". */
  fields: string[];
  from: Task;
  to: Task;
}

export interface ArtifactChange {
  path: string;
  /** "content" when sha256/bytes differ; "meta" when only role/note/embed presence do. */
  kind: "content" | "meta";
  from: Artifact;
  to: Artifact;
}

export interface BatonDiff {
  identical: boolean;
  oldDigest: string;
  newDigest: string;
  title?: FieldChange;
  goal?: FieldChange;
  state?: FieldChange;
  tasksAdded: Task[];
  tasksRemoved: Task[];
  tasksChanged: TaskChange[];
  artifactsAdded: Artifact[];
  artifactsRemoved: Artifact[];
  artifactsChanged: ArtifactChange[];
  /** Fact keys added, removed or altered, sorted. */
  factsChanged: string[];
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function taskFieldsChanged(from: Task, to: Task): string[] {
  const fields: string[] = [];
  if (from.title !== to.title) fields.push("title");
  if (from.status !== to.status) fields.push("status");
  if ((from.priority ?? "normal") !== (to.priority ?? "normal")) fields.push("priority");
  if (!sameList(from.blocked_by, to.blocked_by)) fields.push("blocked_by");
  if ((from.notes ?? "") !== (to.notes ?? "")) fields.push("notes");
  return fields;
}

/** Compare two batons. `identical` is decided by canonical digest. */
export function diffBatons(oldBaton: Baton, newBaton: Baton): BatonDiff {
  const diff: BatonDiff = {
    identical: false,
    oldDigest: batonDigest(oldBaton),
    newDigest: batonDigest(newBaton),
    tasksAdded: [],
    tasksRemoved: [],
    tasksChanged: [],
    artifactsAdded: [],
    artifactsRemoved: [],
    artifactsChanged: [],
    factsChanged: [],
  };
  diff.identical = diff.oldDigest === diff.newDigest;

  if (oldBaton.title !== newBaton.title) diff.title = { from: oldBaton.title, to: newBaton.title };
  if (oldBaton.summary.goal !== newBaton.summary.goal) {
    diff.goal = { from: oldBaton.summary.goal, to: newBaton.summary.goal };
  }
  if (oldBaton.summary.state !== newBaton.summary.state) {
    diff.state = { from: oldBaton.summary.state, to: newBaton.summary.state };
  }

  const oldTasks = new Map((oldBaton.tasks ?? []).map((t) => [t.id, t]));
  for (const task of newBaton.tasks ?? []) {
    const before = oldTasks.get(task.id);
    if (before === undefined) {
      diff.tasksAdded.push(task);
      continue;
    }
    oldTasks.delete(task.id);
    const fields = taskFieldsChanged(before, task);
    if (fields.length > 0) diff.tasksChanged.push({ id: task.id, fields, from: before, to: task });
  }
  diff.tasksRemoved = [...oldTasks.values()];

  const oldArtifacts = new Map((oldBaton.artifacts ?? []).map((a) => [a.path, a]));
  for (const artifact of newBaton.artifacts ?? []) {
    const before = oldArtifacts.get(artifact.path);
    if (before === undefined) {
      diff.artifactsAdded.push(artifact);
      continue;
    }
    oldArtifacts.delete(artifact.path);
    if (before.sha256 !== artifact.sha256 || before.bytes !== artifact.bytes) {
      diff.artifactsChanged.push({ path: artifact.path, kind: "content", from: before, to: artifact });
    } else if (
      (before.role ?? "other") !== (artifact.role ?? "other") ||
      (before.note ?? "") !== (artifact.note ?? "") ||
      (before.embed !== undefined) !== (artifact.embed !== undefined)
    ) {
      diff.artifactsChanged.push({ path: artifact.path, kind: "meta", from: before, to: artifact });
    }
  }
  diff.artifactsRemoved = [...oldArtifacts.values()];

  const oldFacts = oldBaton.facts ?? {};
  const newFacts = newBaton.facts ?? {};
  const keys = new Set([...Object.keys(oldFacts), ...Object.keys(newFacts)]);
  diff.factsChanged = [...keys].filter((k) => oldFacts[k] !== newFacts[k]).sort();

  return diff;
}

function quote(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ");
  return `"${flat.length > max ? flat.slice(0, max - 1) + "…" : flat}"`;
}

/** Render a diff as compact, line-oriented text (one change per line). */
export function renderDiff(diff: BatonDiff): string {
  if (diff.identical) return `identical (${diff.newDigest})`;

  const lines: string[] = [`${diff.oldDigest} -> ${diff.newDigest}`];
  if (diff.title !== undefined) lines.push(`~ title: ${quote(diff.title.from)} -> ${quote(diff.title.to)}`);
  if (diff.goal !== undefined) lines.push(`~ summary.goal: ${quote(diff.goal.from)} -> ${quote(diff.goal.to)}`);
  if (diff.state !== undefined) lines.push(`~ summary.state: ${quote(diff.state.from)} -> ${quote(diff.state.to)}`);

  for (const t of diff.tasksAdded) lines.push(`+ task ${t.id} [${t.status}] ${quote(t.title)}`);
  for (const t of diff.tasksRemoved) lines.push(`- task ${t.id} [${t.status}] ${quote(t.title)}`);
  for (const c of diff.tasksChanged) {
    const details = c.fields
      .map((f) => {
        if (f === "status") return `status ${c.from.status} -> ${c.to.status}`;
        if (f === "priority") return `priority ${c.from.priority ?? "normal"} -> ${c.to.priority ?? "normal"}`;
        if (f === "title") return `title ${quote(c.from.title, 30)} -> ${quote(c.to.title, 30)}`;
        return f;
      })
      .join(", ");
    lines.push(`~ task ${c.id}: ${details}`);
  }

  for (const a of diff.artifactsAdded) lines.push(`+ artifact ${a.path} (${a.bytes} bytes)`);
  for (const a of diff.artifactsRemoved) lines.push(`- artifact ${a.path}`);
  for (const c of diff.artifactsChanged) {
    lines.push(
      c.kind === "content"
        ? `~ artifact ${c.path}: content sha256 ${c.from.sha256.slice(0, 12)}… -> ${c.to.sha256.slice(0, 12)}…`
        : `~ artifact ${c.path}: metadata`
    );
  }

  for (const key of diff.factsChanged) lines.push(`~ fact ${key}`);
  return lines.join("\n");
}
