/**
 * Minimal ambient declarations for the handful of Node.js built-ins this
 * project uses. Declaring them in-repo keeps `typescript` the only
 * devDependency (no `@types/node`); the surface below is intentionally
 * restricted to exactly what `src/` calls, so a typo against a real Node
 * API still fails to compile.
 */

type BufferEncoding = "utf8" | "base64" | "hex";

interface Buffer extends Uint8Array {
  toString(encoding?: BufferEncoding): string;
  equals(other: Uint8Array): boolean;
}

declare var Buffer: {
  from(data: string, encoding?: BufferEncoding): Buffer;
  from(data: Uint8Array | ArrayBuffer | readonly number[]): Buffer;
  isBuffer(value: unknown): value is Buffer;
};

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:fs" {
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function isAbsolute(p: string): boolean;
}

declare var process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
