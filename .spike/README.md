# Phase 1 spike harness (dev only, never imported by the plugin)

Recorded evidence for the tokens-per-second design. Nothing here is part of the plugin bundle:
`package.json` `files` does not include `.spike/` and no plugin module imports it.

- `spike.mjs <agentId> <maxSeconds> <out.jsonl> [--poll]` - records everything a plugin can observe for one
  agent: turn boundaries, per-delta arrival times and char counts, token samples (pushes and 3 s polls).
- `analyze.mjs <run.jsonl>` - cadence, chars/token, token staleness, window sweep.
- `engine-compare.mjs runs/*.jsonl` - compares candidate engine formulas with leave-one-out calibration.
- `run-trial.sh <name> <agentId> "<prompt>"` - start recorder, send prompt, analyze.
- `runs/*.jsonl` - recorded turns on pi/deepseek/deepseek-flash (answer-heavy A2, thinking-heavy B and D,
  tool-heavy C2 and E2, text-then-stall C3). **Not in the repository**: these are raw timing data from real
  sessions and are gitignored, so they only exist on the machine that recorded them. The tests do not need
  them; they use `tests/fixtures/runs.ts`, which `make-fixtures.mjs` derives from these files. To re-record,
  run `spike.mjs` against a live agent and regenerate the fixtures.
