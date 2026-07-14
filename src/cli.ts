#!/usr/bin/env node
/**
 * The `batonfile` command-line interface. All format logic lives in the
 * pure modules (validate, lint, pack, canonical, show, diff); this file
 * only parses flags, reads and writes files, and maps findings to exit
 * codes:
 *
 *   0  success (valid baton, clean lint, identical diff, files written)
 *   1  findings (invalid baton, lint errors, differences, digest mismatch)
 *   2  usage or I/O error (unknown flag, unreadable file)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { batonDigest, canonicalize } from "./canonical.js";
import { diffBatons, renderDiff } from "./diff.js";
import { formatBytes } from "./digest.js";
import { lintBaton } from "./lint.js";
import {
  PackError,
  createBaton,
  makeArtifact,
  parseSummaryMarkdown,
  parseTaskFlag,
  parseTaskList,
} from "./pack.js";
import { renderBriefing } from "./show.js";
import { UnpackError, unpackBaton } from "./unpack.js";
import { validateBaton } from "./validate.js";
import { FORMAT_VERSION, VERSION } from "./version.js";
import type { Artifact, ArtifactRole, Baton, Decision, From, Issue, Task } from "./types.js";

// ---------------------------------------------------------------------------
// Errors and small helpers
// ---------------------------------------------------------------------------

/** Bad invocation: unknown flag, missing argument. Exit 2. */
class UsageError extends Error {}
/** Unreadable input or unwritable output. Exit 2. */
class IoError extends Error {}
/** A finding the command exists to report. Exit 1. */
class FindingError extends Error {}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw new IoError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

function readBytes(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch (e) {
    throw new IoError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

function parseJson(file: string): unknown {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new FindingError(`${file}: not valid JSON: ${(e as Error).message}`);
  }
}

function printIssues(issues: Issue[]): void {
  for (const issue of issues) {
    console.log(`  ${issue.path}: ${issue.message} [${issue.code}]`);
  }
}

/** Load a file that must already be a valid baton, or throw a finding. */
function loadValidBaton(file: string): Baton {
  const doc = parseJson(file);
  const errors = validateBaton(doc);
  if (errors.length > 0) {
    console.log(`${file}: INVALID — ${errors.length} error(s)`);
    printIssues(errors);
    throw new FindingError(`${file} is not a valid baton`);
  }
  return doc as Baton;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function summarizeBaton(baton: Baton): string {
  const tasks = baton.tasks ?? [];
  const artifacts = baton.artifacts ?? [];
  const embedded = artifacts.reduce((sum, a) => sum + (a.embed !== undefined ? a.bytes : 0), 0);
  const parts = [`${tasks.length} task(s)`, `${artifacts.length} artifact(s)`];
  if (embedded > 0) parts.push(`${formatBytes(embedded)} embedded`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface FlagSpec {
  /** Canonical long name without dashes, e.g. "out". */
  name: string;
  alias?: string;
  takesValue: boolean;
  repeatable?: boolean;
}

interface ParsedArgs {
  values: Map<string, string[]>;
  positionals: string[];
}

function parseArgs(argv: string[], specs: FlagSpec[], command: string): ParsedArgs {
  const byFlag = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byFlag.set(`--${spec.name}`, spec);
    if (spec.alias !== undefined) byFlag.set(spec.alias, spec);
  }
  const values = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    let flag = arg;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      flag = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    const spec = byFlag.get(flag);
    if (spec === undefined) throw new UsageError(`unknown option "${flag}" for "${command}"`);
    let value = "";
    if (spec.takesValue) {
      if (inline !== undefined) {
        value = inline;
      } else {
        i += 1;
        const next = argv[i];
        if (next === undefined) throw new UsageError(`option "--${spec.name}" needs a value`);
        value = next;
      }
    } else if (inline !== undefined) {
      throw new UsageError(`option "--${spec.name}" does not take a value`);
    }
    const list = values.get(spec.name) ?? [];
    if (list.length > 0 && spec.repeatable !== true) {
      throw new UsageError(`option "--${spec.name}" given more than once`);
    }
    list.push(value);
    values.set(spec.name, list);
  }
  return { values, positionals };
}

function one(args: ParsedArgs, name: string): string | undefined {
  const list = args.values.get(name);
  return list === undefined ? undefined : (list[list.length - 1] as string);
}

function many(args: ParsedArgs, name: string): string[] {
  return args.values.get(name) ?? [];
}

function has(args: ParsedArgs, name: string): boolean {
  return args.values.has(name);
}

function wantPositionals(args: ParsedArgs, count: number, usage: string): string[] {
  if (args.positionals.length !== count) {
    throw new UsageError(`expected ${usage}`);
  }
  return args.positionals;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const MAIN_HELP = `batonfile ${VERSION} — validated agent handoff bundles (batonfile/${FORMAT_VERSION})

Usage: batonfile <command> [options]

Commands:
  init                 write a starter baton.json to fill in
  pack                 build a baton from flags, markdown files and artifacts
  validate <baton>     check schema, references and embedded-content digests
  lint <baton>         validate plus handoff-quality warnings
  show <baton>         render a human briefing (markdown, to stdout)
  unpack <baton>       extract embedded artifacts into a directory
  diff <old> <new>     compare two batons (summary, tasks, artifacts, facts)
  digest <baton>       print the canonical content digest (btn_…)

Options:
  -h, --help           show this help (or "batonfile <command> --help")
  -V, --version        print the tool version

Exit codes: 0 ok · 1 findings (invalid, differences, mismatches) · 2 usage or I/O error.`;

const COMMAND_HELP: Record<string, string> = {
  init: `Usage: batonfile init [options]

Write a starter baton with TODO placeholders, then edit it and run
"batonfile lint" until the handoff is worth passing on.

Options:
  -o, --out <file>     output path (default: baton.json)
      --agent <name>   record the producing agent in "from"
      --session <id>   record the producing session (requires --agent)
      --force          overwrite an existing file`,
  pack: `Usage: batonfile pack --title <t> [options]

Build a baton from flags and markdown sources. Goal and state may come
from --goal/--state or from a --summary file with ## Goal / ## State
sections; flags win when both are present.

Options:
      --title <text>        baton title (required)
      --goal <text>         what the work is trying to achieve
      --state <text>        where things stand right now
      --summary <file>      markdown with ## Goal / ## State / ## Context /
                            ## Decisions / ## Constraints sections
      --context <text>      key fact for the receiver (repeatable)
      --constraint <text>   hard constraint (repeatable)
      --decision <text>     "what — why" decision (repeatable)
      --task <text>         one task: "[x|~|!] title (high|low) (after T1)" (repeatable)
      --tasks <file>        markdown task list: - [ ] / - [x] / - [~] / - [!]
      --artifact <p[:role]> file to carry along; role is code|config|doc|data|log|other (repeatable)
      --root <dir>          directory artifact paths are relative to (default: .)
      --max-embed <bytes>   embed files up to this size, larger go by reference (default: 262144)
      --no-embed            never embed content, record digests only
      --fact <key=value>    flat fact (repeatable)
      --agent <name>        producing agent for "from"
      --session <id>        producing session id (requires --agent)
      --label <text>        free-form producer label (requires --agent)
      --created-at <iso>    override the timestamp (for reproducible packs)
  -o, --out <file>          output path (default: baton.json)
      --stdout              write the baton to stdout instead of a file
      --quiet               suppress the status line`,
  validate: `Usage: batonfile validate <baton> [options]

Check a baton against batonfile/${FORMAT_VERSION}: structure, enums and limits;
task-id references and blocked_by cycles; artifact path safety; and that
every embedded content decodes to its declared sha256 and byte count.

Options:
      --quiet          print nothing, just set the exit code
Exit codes: 0 valid · 1 invalid · 2 unreadable`,
  lint: `Usage: batonfile lint <baton> [options]

Validate, then apply handoff-quality rules (thin goal/state, blocked
tasks with no blocker, stale blockers, unverifiable or oversized
artifacts, missing open work). Warnings do not fail the exit code
unless --strict is given.

Options:
      --strict         exit 1 when there are warnings`,
  show: `Usage: batonfile show <baton>

Render the baton as a markdown briefing: goal, state, decisions,
constraints, tasks and artifacts, in pickup order.`,
  unpack: `Usage: batonfile unpack <baton> --out <dir> [options]

Extract embedded artifacts. Every payload is re-hashed against its
declared sha256 before anything is written; by-reference artifacts are
reported as skipped.

Options:
      --out <dir>      output directory (required)
      --force          overwrite existing files`,
  diff: `Usage: batonfile diff <old> <new>

Compare two batons: summary fields, tasks by id, artifacts by path
(content changes detected via sha256), facts by key.

Exit codes: 0 identical · 1 differences · 2 unreadable or invalid input`,
  digest: `Usage: batonfile digest <baton>

Print the canonical content digest (btn_ + 16 hex chars). Key order and
whitespace of the JSON file do not affect it; meaning does.`,
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit(argv: string[]): number {
  const args = parseArgs(argv, [
    { name: "out", alias: "-o", takesValue: true },
    { name: "agent", takesValue: true },
    { name: "session", takesValue: true },
    { name: "force", takesValue: false },
  ], "init");
  wantPositionals(args, 0, `no arguments after "init"`);

  const out = one(args, "out") ?? "baton.json";
  if (!has(args, "force") && existsSync(out)) {
    throw new UsageError(`${out} already exists (use --force to overwrite)`);
  }
  const baton: Baton = {
    batonfile: FORMAT_VERSION,
    title: "TODO: one line naming this handoff",
    created_at: nowIso(),
    summary: {
      goal: "TODO: what the work is ultimately trying to achieve",
      state: "TODO: where things stand right now — what works, what does not",
      context: ["TODO: key fact the receiver needs (paths, commands, quirks)"],
      constraints: ["TODO: hard constraint the receiver must respect"],
    },
    tasks: [{ id: "T1", title: "TODO: first open task", status: "open" }],
  };
  const agent = one(args, "agent");
  const session = one(args, "session");
  if (session !== undefined && agent === undefined) throw new UsageError("--session requires --agent");
  if (agent !== undefined) {
    baton.from = session !== undefined ? { agent, session } : { agent };
  }
  writeFileSync(out, canonicalize(baton));
  console.log(`wrote ${out} — fill in the TODOs, then run: batonfile lint ${out}`);
  return 0;
}

function parseArtifactFlag(value: string): { path: string; role: ArtifactRole | undefined } {
  const roles: readonly string[] = ["code", "config", "doc", "data", "log", "other"];
  const at = value.lastIndexOf(":");
  if (at > 0) {
    const suffix = value.slice(at + 1);
    if (roles.includes(suffix)) {
      return { path: value.slice(0, at), role: suffix as ArtifactRole };
    }
  }
  return { path: value, role: undefined };
}

/** Split "what — why" / "what -- why" / "what: why" into a Decision. */
function parseDecisionFlag(text: string): Decision {
  for (const sep of [" — ", " -- ", ": "]) {
    const at = text.indexOf(sep);
    if (at > 0) {
      const why = text.slice(at + sep.length).trim();
      const d: Decision = { what: text.slice(0, at).trim() };
      if (why !== "") d.why = why;
      return d;
    }
  }
  return { what: text.trim() };
}

function cmdPack(argv: string[]): number {
  const args = parseArgs(argv, [
    { name: "title", takesValue: true },
    { name: "goal", takesValue: true },
    { name: "state", takesValue: true },
    { name: "summary", takesValue: true },
    { name: "context", takesValue: true, repeatable: true },
    { name: "constraint", takesValue: true, repeatable: true },
    { name: "decision", takesValue: true, repeatable: true },
    { name: "task", takesValue: true, repeatable: true },
    { name: "tasks", takesValue: true },
    { name: "artifact", takesValue: true, repeatable: true },
    { name: "root", takesValue: true },
    { name: "max-embed", takesValue: true },
    { name: "no-embed", takesValue: false },
    { name: "fact", takesValue: true, repeatable: true },
    { name: "agent", takesValue: true },
    { name: "session", takesValue: true },
    { name: "label", takesValue: true },
    { name: "created-at", takesValue: true },
    { name: "out", alias: "-o", takesValue: true },
    { name: "stdout", takesValue: false },
    { name: "quiet", takesValue: false },
  ], "pack");
  wantPositionals(args, 0, `no arguments after "pack" (all inputs are flags)`);

  const title = one(args, "title");
  if (title === undefined) throw new UsageError("pack needs --title");

  // Summary: file first, explicit flags override / append.
  let goal = one(args, "goal");
  let state = one(args, "state");
  const context: string[] = [];
  const constraints: string[] = [];
  const decisions: Decision[] = [];
  const summaryFile = one(args, "summary");
  if (summaryFile !== undefined) {
    const parsed = parseSummaryMarkdown(readText(summaryFile));
    goal = goal ?? parsed.goal;
    state = state ?? parsed.state;
    context.push(...parsed.context);
    constraints.push(...parsed.constraints);
    decisions.push(...parsed.decisions);
  }
  context.push(...many(args, "context"));
  constraints.push(...many(args, "constraint"));
  decisions.push(...many(args, "decision").map(parseDecisionFlag));
  if (goal === undefined) throw new UsageError("pack needs --goal or a ## Goal section in --summary");
  if (state === undefined) throw new UsageError("pack needs --state or a ## State section in --summary");

  // Tasks: file first (ids T1…Tn), then --task flags continue the numbering.
  const tasks: Task[] = [];
  const tasksFile = one(args, "tasks");
  if (tasksFile !== undefined) tasks.push(...parseTaskList(readText(tasksFile)));
  for (const flag of many(args, "task")) {
    tasks.push(parseTaskFlag(flag, `T${tasks.length + 1}`));
  }

  // Artifacts.
  const root = one(args, "root") ?? ".";
  const maxEmbedRaw = one(args, "max-embed");
  // Strict digits only: parseInt would silently read "64k" as 64.
  if (maxEmbedRaw !== undefined && !/^\d+$/.test(maxEmbedRaw)) {
    throw new UsageError(`--max-embed must be a non-negative integer (bytes), got "${maxEmbedRaw}"`);
  }
  const maxEmbed = maxEmbedRaw === undefined ? 256 * 1024 : Number.parseInt(maxEmbedRaw, 10);
  const neverEmbed = has(args, "no-embed");
  const artifacts: Artifact[] = [];
  for (const flag of many(args, "artifact")) {
    const { path, role } = parseArtifactFlag(flag);
    const relPath = path.replace(/^\.\//, "");
    if (isAbsolute(relPath)) throw new UsageError(`artifact path "${relPath}" must be relative to --root`);
    const data = readBytes(join(root, relPath));
    const embed = !neverEmbed && data.length <= maxEmbed;
    const opts = role !== undefined ? { role, embed } : { embed };
    artifacts.push(makeArtifact(relPath, data, opts));
  }

  // Facts.
  const facts: Record<string, string> = {};
  for (const flag of many(args, "fact")) {
    const eq = flag.indexOf("=");
    if (eq <= 0) throw new UsageError(`--fact needs key=value, got "${flag}"`);
    facts[flag.slice(0, eq)] = flag.slice(eq + 1);
  }

  // Producer identity.
  const agent = one(args, "agent");
  const session = one(args, "session");
  const label = one(args, "label");
  if ((session !== undefined || label !== undefined) && agent === undefined) {
    throw new UsageError("--session and --label require --agent");
  }
  let from: From | undefined;
  if (agent !== undefined) {
    from = { agent };
    if (session !== undefined) from.session = session;
    if (label !== undefined) from.label = label;
  }

  const createOpts = {
    title,
    goal,
    state,
    createdAt: one(args, "created-at") ?? nowIso(),
    context,
    constraints,
    decisions,
    tasks,
    artifacts,
    facts,
    ...(from !== undefined ? { from } : {}),
  };
  const baton = createBaton(createOpts);

  // A packed baton must always validate; anything else is a finding.
  const errors = validateBaton(baton as unknown);
  if (errors.length > 0) {
    console.error(`packed baton failed validation — ${errors.length} error(s):`);
    for (const issue of errors) console.error(`  ${issue.path}: ${issue.message} [${issue.code}]`);
    return 1;
  }

  const text = canonicalize(baton);
  const digest = batonDigest(baton);
  if (has(args, "stdout")) {
    process.stdout.write(text);
    if (!has(args, "quiet")) console.error(`packed ${digest} (${summarizeBaton(baton)})`);
  } else {
    const out = one(args, "out") ?? "baton.json";
    writeFileSync(out, text);
    if (!has(args, "quiet")) console.log(`packed ${digest} -> ${out} (${summarizeBaton(baton)})`);
  }
  return 0;
}

function cmdValidate(argv: string[]): number {
  const args = parseArgs(argv, [{ name: "quiet", takesValue: false }], "validate");
  const [file] = wantPositionals(args, 1, "validate <baton>") as [string];
  const quiet = has(args, "quiet");

  const doc = parseJson(file);
  const errors = validateBaton(doc);
  if (errors.length > 0) {
    if (!quiet) {
      console.log(`${file}: INVALID — ${errors.length} error(s)`);
      printIssues(errors);
    }
    return 1;
  }
  if (!quiet) {
    const baton = doc as Baton;
    console.log(`${file}: OK — batonfile/${baton.batonfile}, ${summarizeBaton(baton)}, ${batonDigest(baton)}`);
  }
  return 0;
}

function cmdLint(argv: string[]): number {
  const args = parseArgs(argv, [{ name: "strict", takesValue: false }], "lint");
  const [file] = wantPositionals(args, 1, "lint <baton>") as [string];

  const baton = loadValidBaton(file);
  const warnings = lintBaton(baton);
  if (warnings.length === 0) {
    console.log(`${file}: clean — no warnings`);
    return 0;
  }
  console.log(`${file}: ${warnings.length} warning(s)`);
  printIssues(warnings);
  return has(args, "strict") ? 1 : 0;
}

function cmdShow(argv: string[]): number {
  const args = parseArgs(argv, [], "show");
  const [file] = wantPositionals(args, 1, "show <baton>") as [string];
  const baton = loadValidBaton(file);
  process.stdout.write(renderBriefing(baton));
  return 0;
}

function cmdUnpack(argv: string[]): number {
  const args = parseArgs(argv, [
    { name: "out", takesValue: true },
    { name: "force", takesValue: false },
  ], "unpack");
  const [file] = wantPositionals(args, 1, "unpack <baton> --out <dir>") as [string];
  const out = one(args, "out");
  if (out === undefined) throw new UsageError("unpack needs --out <dir>");

  const baton = loadValidBaton(file);
  let result;
  try {
    result = unpackBaton(baton, out, { force: has(args, "force") });
  } catch (e) {
    if (e instanceof UnpackError) throw new FindingError(e.message);
    throw e;
  }
  for (const w of result.written) console.log(`wrote ${join(out, w.path)} (${w.bytes} bytes, sha256 ok)`);
  for (const s of result.skipped) console.log(`skipped ${s.path} (${s.reason})`);
  console.log(`unpacked ${result.written.length} file(s) to ${out}`);
  return 0;
}

function cmdDiff(argv: string[]): number {
  const args = parseArgs(argv, [], "diff");
  const [oldFile, newFile] = wantPositionals(args, 2, "diff <old> <new>") as [string, string];

  // GNU-diff convention: broken input is "trouble" (2), not "different" (1).
  const load = (file: string): Baton => {
    let doc: unknown;
    try {
      doc = parseJson(file);
    } catch (e) {
      if (e instanceof FindingError) throw new IoError(e.message);
      throw e;
    }
    const errors = validateBaton(doc);
    if (errors.length > 0) {
      throw new IoError(`${file} is not a valid baton (${errors.length} error(s) — run "batonfile validate ${file}")`);
    }
    return doc as Baton;
  };
  const diff = diffBatons(load(oldFile), load(newFile));
  console.log(renderDiff(diff));
  return diff.identical ? 0 : 1;
}

function cmdDigest(argv: string[]): number {
  const args = parseArgs(argv, [], "digest");
  const [file] = wantPositionals(args, 1, "digest <baton>") as [string];
  const baton = loadValidBaton(file);
  console.log(batonDigest(baton));
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (argv: string[]) => number> = {
  init: cmdInit,
  pack: cmdPack,
  validate: cmdValidate,
  lint: cmdLint,
  show: cmdShow,
  unpack: cmdUnpack,
  diff: cmdDiff,
  digest: cmdDigest,
};

export function run(argv: string[]): number {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    console.log(MAIN_HELP);
    return 0;
  }
  if (first === "--version" || first === "-V") {
    console.log(VERSION);
    return 0;
  }
  const command = COMMANDS[first];
  if (command === undefined) {
    throw new UsageError(`unknown command "${first}"`);
  }
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(COMMAND_HELP[first] as string);
    return 0;
  }
  return command(rest);
}

function main(): void {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`batonfile: ${e.message}`);
      console.error(`run "batonfile --help" for usage`);
      process.exit(2);
    }
    if (e instanceof IoError) {
      console.error(`batonfile: ${e.message}`);
      process.exit(2);
    }
    if (e instanceof FindingError) {
      console.error(`batonfile: ${e.message}`);
      process.exit(1);
    }
    if (e instanceof PackError) {
      console.error(`batonfile: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

main();
