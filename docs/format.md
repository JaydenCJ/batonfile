# The batonfile/1 format

A baton is a single JSON document that carries a work handoff from one
agent session to the next: the conversation summary in structured form,
the open tasks, and the files worth carrying forward. This page is the
authoritative field-by-field specification for format major version `1`.
The validator in this repository implements exactly these rules.

Design goals, in order:

1. **Self-contained** — one file holds everything the receiver needs;
   embedded artifacts can be reconstructed byte-for-byte and verified by
   digest.
2. **Validated** — a baton either conforms or it does not; every rule has a
   stable machine code and a JSON path.
3. **Deterministic** — canonical field order, so batons diff cleanly in
   git, and a content-addressed identity (`btn_…`) that ignores key order
   and whitespace but nothing else.
4. **Not a memory database** — a baton is a point-in-time briefing, written
   once at handoff. There is no store, no server, no retrieval layer.

## Top-level document

| Field | Type | Required | Rules |
|---|---|---|---|
| `batonfile` | string | yes | format major version; this spec is `"1"` |
| `title` | string | yes | 1–200 chars |
| `created_at` | string | yes | ISO-8601 UTC instant with trailing `Z`, e.g. `2026-07-12T18:04:00Z`; must be a real date (`E_TIMESTAMP` otherwise) |
| `from` | object | no | producer identity, see below |
| `summary` | object | yes | the structured summary, see below |
| `tasks` | array | no | work items, see below |
| `artifacts` | array | no | carried files, see below |
| `facts` | object | no | flat string→string map; keys ≤128 chars, values ≤2000 |

Unknown keys are errors (`E_UNKNOWN_KEY`) at every object level, with one
escape hatch: keys starting with `x-` are reserved for extensions and are
ignored by validation but preserved by canonicalization. A reader that
encounters a `batonfile` major version it does not know must refuse the
whole document (`E_VERSION`) rather than guess.

## `from`

| Field | Type | Required | Rules |
|---|---|---|---|
| `agent` | string | yes | producing agent or tool name |
| `session` | string | no | producer's session identifier |
| `label` | string | no | free-form label |

## `summary`

| Field | Type | Required | Rules |
|---|---|---|---|
| `goal` | string | yes | what the work is trying to achieve; ≤4000 chars |
| `state` | string | yes | where things stand right now; ≤4000 chars |
| `context` | string[] | no | key facts, each non-empty |
| `decisions` | object[] | no | `{ what, why? }`, `what` required |
| `constraints` | string[] | no | hard constraints, each non-empty |

`goal` and `state` are deliberately the only required prose in the whole
format: a handoff without them is not a handoff.

## `tasks[]`

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`, unique in the baton |
| `title` | string | yes | 1–300 chars |
| `status` | enum | yes | `open` · `in_progress` · `blocked` · `done` |
| `priority` | enum | no | `high` · `normal` (default) · `low` |
| `blocked_by` | string[] | no | existing task ids; no self-reference, no duplicates, **no cycles** (`E_CYCLE` reports the full chain) |
| `notes` | string | no | ≤4000 chars |

Task order in the array is presentation order and is preserved; reordering
tasks changes the canonical digest.

## `artifacts[]`

| Field | Type | Required | Rules |
|---|---|---|---|
| `path` | string | yes | relative, forward slashes, no `.`/`..`/empty segments, no absolute or drive-letter paths, ≤512 chars, unique |
| `role` | enum | no | `code` · `config` · `doc` · `data` · `log` · `other` (default) |
| `sha256` | string | yes | 64 lowercase hex chars — the digest of the exact file bytes, embedded or not |
| `bytes` | integer | yes | exact byte length, ≥0 |
| `embed` | object | no | `{ encoding: "utf8" \| "base64", content }`; absent = by reference |
| `note` | string | no | why this file matters |

Integrity rules when `embed` is present: the content must decode
(`E_ENCODING` for non-canonical base64 or utf8 that does not round-trip),
the decoded bytes must hash to `sha256` (`E_DIGEST`), and their length must
equal `bytes` (`E_BYTES`). Producers should embed text as `utf8` and binary
as `base64`; consumers must accept either. A by-reference artifact still
carries `sha256` and `bytes` so the receiver can verify a copy obtained
elsewhere.

## Canonical form and identity

Canonical serialization uses the field order of the tables above, two-space
indentation, sorted `facts` keys, and `x-` extension keys sorted after the
known fields. Arrays are never reordered. The **baton digest** is
`btn_` + the first 16 hex chars of the SHA-256 of the compact canonical
serialization: two files with different key order or whitespace but the
same meaning have the same digest.

## Error codes

`E_TYPE`, `E_REQUIRED`, `E_EMPTY`, `E_LENGTH`, `E_ENUM`, `E_PATTERN`,
`E_UNKNOWN_KEY`, `E_VERSION`, `E_TIMESTAMP`, `E_DUPLICATE`, `E_REF`,
`E_CYCLE`, `E_PATH`, `E_ENCODING`, `E_DIGEST`, `E_BYTES`. Codes and the
JSON paths they attach to are stable API from 0.1.0 on; tooling may key
off them.

## Versioning policy

The `batonfile` field carries the format's **major** version only. Within
a major version, additive change happens exclusively through `x-` extension
keys; any change to required fields, enums, integrity rules or canonical
order is a new major version. Format version and tool version are
independent: batonfile 0.x tools read and write `batonfile/1`.
