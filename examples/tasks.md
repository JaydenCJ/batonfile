# Open work

- [x] Reproduce the flake locally and capture a failing run
- [x] Identify the root cause in the payment client retry loop
- [~] Apply the backoff patch from patch/retry-backoff.diff (high)
- [ ] Run the integration suite 50 times to confirm the fix (after T3)
- [!] Delete the retry workaround in deploy scripts (after T4)
  The workaround lives outside this repo; needs someone with deploy access.
