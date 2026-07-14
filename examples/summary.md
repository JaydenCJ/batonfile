# Handoff — flaky checkout test

## Goal

Make `checkout.integration.test` pass reliably on every run so the release
pipeline stops needing manual re-runs. The test exercises the retry path of
the payment client against the local stub server.

## Where things stand

Reproduced the flake locally: it fails roughly 1 run in 7. Root cause found —
the payment client's retry uses a fixed 50 ms delay, so when the stub takes
longer to boot, all three attempts land before the socket is listening. A
backoff patch is drafted (see artifacts) but not yet applied; the test itself
has no bug.

## Context

- The stub server binds 127.0.0.1:9402; the port is hard-coded in `test/helpers/stub.ts`.
- Run a single flake check with `npm run test:integration -- --grep checkout`.
- The repo pins Node 22; `nvm use` picks it up from `.nvmrc`.

## Decisions

- Fix the client, not the test — the sleep-based workaround was rejected: it hides the race instead of removing it.
- Use exponential backoff with jitter — three attempts at 50/150/450 ms bounds the added latency at under a second.

## Constraints

- Do not raise the global test timeout; CI budget is fixed.
- The public API of `PaymentClient` must not change in this fix.
