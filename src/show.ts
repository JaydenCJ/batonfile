/**
 * The receiving end of a handoff: render a baton as a markdown briefing a
 * human (or an agent's context window) can absorb in one read. Section
 * order mirrors how a receiver actually picks work up — goal, state,
 * decisions and constraints before the task list, artifacts last. Task
 * markers reuse the `[ ]`/`[~]`/`[!]`/`[x]` dialect that `pack --tasks`
 * parses, so a briefing's task list round-trips back into a baton.
 */
import { batonDigest } from "./canonical.js";
import { formatBytes } from "./digest.js";
import type { Baton, Task } from "./types.js";

const STATUS_MARKER: Record<Task["status"], string> = {
  open: "[ ]",
  in_progress: "[~]",
  blocked: "[!]",
  done: "[x]",
};

function taskLine(task: Task): string {
  const parts = [`- ${STATUS_MARKER[task.status]} ${task.id}`];
  if (task.priority !== undefined && task.priority !== "normal") parts.push(task.priority);
  parts.push(task.title);
  if (task.blocked_by !== undefined && task.blocked_by.length > 0) {
    parts.push(`(after ${task.blocked_by.join(", ")})`);
  }
  const line = parts.join(" · ");
  return task.notes === undefined ? line : `${line}\n  ${task.notes}`;
}

function countTasks(tasks: Task[]): string {
  const counts: Record<Task["status"], number> = { open: 0, in_progress: 0, blocked: 0, done: 0 };
  for (const t of tasks) counts[t.status] += 1;
  const parts: string[] = [];
  if (counts.open > 0) parts.push(`${counts.open} open`);
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  if (counts.done > 0) parts.push(`${counts.done} done`);
  return parts.join(" · ");
}

/** Render the briefing. Deterministic: same baton, same bytes. */
export function renderBriefing(baton: Baton): string {
  const lines: string[] = [];
  lines.push(`# Baton: ${baton.title}`);

  const meta: string[] = [batonDigest(baton), `batonfile/${baton.batonfile}`];
  if (baton.from !== undefined) {
    meta.push(baton.from.session !== undefined
      ? `from ${baton.from.agent} (session ${baton.from.session})`
      : `from ${baton.from.agent}`);
    if (baton.from.label !== undefined) meta.push(baton.from.label);
  }
  meta.push(baton.created_at);
  lines.push(meta.join(" · "), "");

  lines.push("## Goal", "", baton.summary.goal, "");
  lines.push("## Where things stand", "", baton.summary.state, "");

  const context = baton.summary.context ?? [];
  if (context.length > 0) {
    lines.push("## Context", "");
    for (const item of context) lines.push(`- ${item}`);
    lines.push("");
  }

  const decisions = baton.summary.decisions ?? [];
  if (decisions.length > 0) {
    lines.push("## Decisions", "");
    for (const d of decisions) {
      lines.push(d.why === undefined ? `- ${d.what}` : `- ${d.what} — ${d.why}`);
    }
    lines.push("");
  }

  const constraints = baton.summary.constraints ?? [];
  if (constraints.length > 0) {
    lines.push("## Constraints", "");
    for (const item of constraints) lines.push(`- ${item}`);
    lines.push("");
  }

  const tasks = baton.tasks ?? [];
  if (tasks.length > 0) {
    lines.push(`## Tasks (${countTasks(tasks)})`, "");
    for (const t of tasks) lines.push(taskLine(t));
    lines.push("");
  }

  const artifacts = baton.artifacts ?? [];
  if (artifacts.length > 0) {
    const embedded = artifacts.filter((a) => a.embed !== undefined);
    const referenced = artifacts.length - embedded.length;
    const total = embedded.reduce((sum, a) => sum + a.bytes, 0);
    const shape = referenced > 0
      ? `${embedded.length} embedded · ${referenced} by reference`
      : `${embedded.length} embedded`;
    lines.push(`## Artifacts (${shape}, ${formatBytes(total)} carried)`, "");
    for (const a of artifacts) {
      const parts = [
        `- ${a.path}`,
        a.role ?? "other",
        formatBytes(a.bytes),
        a.embed !== undefined ? "embedded" : "by reference",
        `sha256 ${a.sha256.slice(0, 12)}…`,
      ];
      const line = parts.join(" · ");
      lines.push(a.note === undefined ? line : `${line}\n  ${a.note}`);
    }
    lines.push("");
  }

  const facts = baton.facts ?? {};
  const factKeys = Object.keys(facts).sort();
  if (factKeys.length > 0) {
    lines.push("## Facts", "");
    for (const key of factKeys) lines.push(`- ${key}: ${facts[key] as string}`);
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}
