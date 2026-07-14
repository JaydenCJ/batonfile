# Repro notes

Loop the single test until it fails (usually within ten iterations):

```bash
for i in $(seq 1 20); do
  npm run test:integration -- --grep checkout || break
done
```

Failing signature in the log:

```text
PaymentClient: attempt 3/3 failed: connect ECONNREFUSED 127.0.0.1:9402
```

All three attempts fail within ~150 ms of process start; the stub's
"listening" line appears ~180 ms in. That gap is the whole bug.
