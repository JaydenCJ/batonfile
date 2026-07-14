/**
 * Handoff-quality lint: rules that judge whether a *valid* baton is a
 * *good* baton. Validity is the schema's job (validate.ts); these rules
 * catch the handoffs that pass the schema but will still strand the
 * receiving agent — a two-word goal, a "blocked" task with no blocker,
 * artifacts nobody can reconstruct.
 *
 * All findings are warnings. Callers should run validateBaton first and
 * only lint documents with zero errors. Deterministic: the wall clock is
 * injected via options so tests can pin "now".
 */
import type { Baton, Issue, Task } from "./types.js";

/** Thresholds the lint rules use (documented in the README lint table). */
export const LINT_LIMITS = {
  /** Goals/states shorter than this read as too thin to act on. */
  thinChars: 20,
  /** A single embed above this many bytes is probably not a handoff artifact. */
  largeEmbed: 256 * 1024,
  /** Total embedded payload above this suggests the baton became a tarball. */
  largeBundle: 1024 * 1024,
  /** Allowed clock skew before created_at counts as "in the future". */
  futureSkewMs: 2 * 60 * 1000,
} as const;

export interface LintOptions {
  /** Current time in ms since epoch; defaults to Date.now(). */
  now?: number;
}

function warn(code: string, path: string, message: string): Issue {
  return { severity: "warning", code, path, message };
}

const PLACEHOLDER_RE = /\b(?:TODO|FIXME|TBD)\b/;

function checkPlaceholder(text: string, path: string, issues: Issue[]): void {
  const m = PLACEHOLDER_RE.exec(text);
  if (m !== null) {
    issues.push(warn("W_PLACEHOLDER", path, `still contains "${m[0]}" — finish the handoff before passing it on`));
  }
}

/**
 * Lint a structurally valid baton. Returns warnings in document order:
 * summary first, then tasks, artifacts, and finally whole-bundle rules.
 */
export function lintBaton(baton: Baton, options: LintOptions = {}): Issue[] {
  const now = options.now ?? Date.now();
  const issues: Issue[] = [];

  // -- placeholders (init templates must not be handed off as-is) -------------
  checkPlaceholder(baton.title, "title", issues);
  checkPlaceholder(baton.summary.goal, "summary.goal", issues);
  checkPlaceholder(baton.summary.state, "summary.state", issues);
  (baton.summary.context ?? []).forEach((item, i) => checkPlaceholder(item, `summary.context[${i}]`, issues));
  (baton.summary.constraints ?? []).forEach((item, i) => checkPlaceholder(item, `summary.constraints[${i}]`, issues));
  (baton.tasks ?? []).forEach((task, i) => checkPlaceholder(task.title, `tasks[${i}].title`, issues));

  // -- summary ---------------------------------------------------------------
  if (baton.summary.goal.trim().length < LINT_LIMITS.thinChars) {
    issues.push(warn("W_THIN_GOAL", "summary.goal",
      `goal is only ${baton.summary.goal.trim().length} characters — too thin for the receiver to act on`));
  }
  if (baton.summary.state.trim().length < LINT_LIMITS.thinChars) {
    issues.push(warn("W_THIN_STATE", "summary.state",
      `state is only ${baton.summary.state.trim().length} characters — say where things actually stand`));
  }

  // -- timestamp ---------------------------------------------------------------
  const created = Date.parse(baton.created_at);
  if (!Number.isNaN(created) && created > now + LINT_LIMITS.futureSkewMs) {
    issues.push(warn("W_FUTURE_TIMESTAMP", "created_at",
      `created_at is in the future — check the producing clock`));
  }

  // -- tasks -------------------------------------------------------------------
  const tasks = baton.tasks ?? [];
  const byId = new Map<string, Task>(tasks.map((t) => [t.id, t]));
  const openWork = tasks.filter((t) => t.status !== "done");
  if (openWork.length === 0) {
    issues.push(warn("W_NO_OPEN_TASKS", "tasks",
      tasks.length === 0
        ? "no tasks at all — if the work is finished, say so in summary.state; if not, list what is left"
        : "every task is done — if the work is finished, say so in summary.state"));
  }

  const seenTitles = new Map<string, string>();
  tasks.forEach((task, i) => {
    const path = `tasks[${i}]`;

    const normalized = task.title.trim().toLowerCase().replace(/\s+/g, " ");
    const firstId = seenTitles.get(normalized);
    if (firstId !== undefined) {
      issues.push(warn("W_DUPLICATE_TITLE", `${path}.title`,
        `same title as task "${firstId}" — merge them or make the difference explicit`));
    } else {
      seenTitles.set(normalized, task.id);
    }

    if (task.status === "blocked") {
      const blockers = task.blocked_by ?? [];
      if (blockers.length === 0 && (task.notes === undefined || task.notes.trim() === "")) {
        issues.push(warn("W_BLOCKED_NO_BLOCKER", `${path}.status`,
          `task "${task.id}" is blocked but names no blocker and has no notes — the receiver cannot unblock it`));
      } else if (blockers.length > 0) {
        const resolved = blockers.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined);
        if (resolved.length > 0 && resolved.every((t) => t.status === "done")) {
          issues.push(warn("W_STALE_BLOCKER", `${path}.blocked_by`,
            `every blocker of "${task.id}" is done — it can probably move to "open"`));
        }
      }
    }
  });

  // -- artifacts ---------------------------------------------------------------
  const artifacts = baton.artifacts ?? [];
  let embeddedTotal = 0;
  artifacts.forEach((artifact, i) => {
    const path = `artifacts[${i}]`;
    if (artifact.embed === undefined) {
      issues.push(warn("W_UNVERIFIABLE_ARTIFACT", `${path}.path`,
        `"${artifact.path}" is by reference only — the receiver cannot reconstruct it from this baton`));
    } else {
      embeddedTotal += artifact.bytes;
      if (artifact.bytes > LINT_LIMITS.largeEmbed) {
        issues.push(warn("W_LARGE_EMBED", `${path}.embed`,
          `"${artifact.path}" embeds ${artifact.bytes} bytes — consider passing it by reference`));
      }
    }
  });
  if (embeddedTotal > LINT_LIMITS.largeBundle) {
    issues.push(warn("W_LARGE_BUNDLE", "artifacts",
      `embedded payload totals ${embeddedTotal} bytes — a baton is a briefing, not an archive`));
  }

  return issues;
}
