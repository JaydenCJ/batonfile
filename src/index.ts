/**
 * Public programmatic API of batonfile. Everything the CLI does is a thin
 * wrapper over these exports, so agents and tooling can produce, check and
 * consume batons in-process without shelling out.
 */
export { VERSION, FORMAT_VERSION } from "./version.js";
export type {
  Artifact,
  ArtifactRole,
  Baton,
  Decision,
  Embed,
  EmbedEncoding,
  From,
  Issue,
  Severity,
  Summary,
  Task,
  TaskPriority,
  TaskStatus,
} from "./types.js";
export { LIMITS, unsafePathReason, validateBaton } from "./validate.js";
export { LINT_LIMITS, lintBaton } from "./lint.js";
export type { LintOptions } from "./lint.js";
export { batonDigest, canonicalize } from "./canonical.js";
export { EmbedError, decodeEmbed, encodeBuffer, formatBytes, isEmbeddableText, sha256Hex } from "./digest.js";
export {
  PackError,
  createBaton,
  makeArtifact,
  parseSummaryMarkdown,
  parseTaskFlag,
  parseTaskList,
} from "./pack.js";
export type { ArtifactOptions, CreateOptions, ParsedSummary } from "./pack.js";
export { renderBriefing } from "./show.js";
export { diffBatons, renderDiff } from "./diff.js";
export type { ArtifactChange, BatonDiff, FieldChange, TaskChange } from "./diff.js";
export { UnpackError, unpackBaton } from "./unpack.js";
export type { SkippedFile, UnpackOptions, UnpackResult, UnpackedFile } from "./unpack.js";
