/**
 * Extract embedded artifacts back onto disk. The one module that writes
 * files, so it is paranoid: every path is re-checked with the same rules
 * the validator enforces (defense in depth against a hand-crafted baton),
 * every decoded payload is re-hashed against the declared sha256 before a
 * byte is written, and existing files are never overwritten without
 * `force`. By-reference artifacts are reported, not silently dropped.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { decodeEmbed, sha256Hex } from "./digest.js";
import { unsafePathReason } from "./validate.js";
import type { Baton } from "./types.js";

export interface UnpackOptions {
  /** Overwrite existing files instead of failing. */
  force?: boolean;
}

export interface UnpackedFile {
  path: string;
  bytes: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface UnpackResult {
  written: UnpackedFile[];
  /** By-reference artifacts that carry no content to extract. */
  skipped: SkippedFile[];
}

/** Thrown on unsafe paths, digest mismatches, or refusal to overwrite. */
export class UnpackError extends Error {}

/**
 * Write every embedded artifact under `outDir`. All-or-nothing per call:
 * the whole baton is checked (paths, digests, collisions) before the
 * first byte is written, so a bad artifact never leaves a half-extracted
 * tree behind.
 */
export function unpackBaton(baton: Baton, outDir: string, options: UnpackOptions = {}): UnpackResult {
  const artifacts = baton.artifacts ?? [];
  const root = resolve(outDir);
  const plan: { relPath: string; absPath: string; data: Buffer }[] = [];
  const skipped: SkippedFile[] = [];
  const planned = new Set<string>();

  for (const artifact of artifacts) {
    const reason = unsafePathReason(artifact.path);
    if (reason !== null) {
      throw new UnpackError(`refusing to extract "${artifact.path}": ${reason}`);
    }
    // Validation already rejects duplicate paths, but this public API can
    // be handed an unvalidated baton — never let one write clobber another.
    if (planned.has(artifact.path)) {
      throw new UnpackError(`duplicate artifact path "${artifact.path}": refusing to write the same file twice`);
    }
    planned.add(artifact.path);
    const absPath = resolve(join(root, artifact.path));
    if (absPath !== root && !absPath.startsWith(root + sep)) {
      // Unreachable if unsafePathReason is correct; kept as a hard backstop.
      throw new UnpackError(`refusing to extract "${artifact.path}": escapes the output directory`);
    }
    if (artifact.embed === undefined) {
      skipped.push({ path: artifact.path, reason: "by reference, no embedded content" });
      continue;
    }
    const data = decodeEmbed(artifact.embed);
    const actual = sha256Hex(data);
    if (actual !== artifact.sha256) {
      throw new UnpackError(
        `digest mismatch for "${artifact.path}": content hashes to ${actual.slice(0, 12)}…, baton declares ${artifact.sha256.slice(0, 12)}…`
      );
    }
    if (options.force !== true && existsSync(absPath)) {
      throw new UnpackError(`"${artifact.path}" already exists in ${outDir} (use --force to overwrite)`);
    }
    plan.push({ relPath: artifact.path, absPath, data });
  }

  const written: UnpackedFile[] = [];
  for (const item of plan) {
    mkdirSync(dirname(item.absPath), { recursive: true });
    writeFileSync(item.absPath, item.data);
    written.push({ path: item.relPath, bytes: item.data.length });
  }
  return { written, skipped };
}
