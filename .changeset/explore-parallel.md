---
"e2e": patch
---

`e2e explore --parallel <n>` (and `parallel` on `explore` from `e2e/runner`) runs up to 5 explorers at once on the same goal, each with its own focus: core flows, edge-case input, state across screens, layouts and roles, and content and controls. Each explorer is a test of the same run with its own worker and budgets, so the app command and a `--session` setup run once. After the run, one model call merges findings that describe the same failure; if it fails, every finding is kept. `run.explore` gains `explorers` and `merge`, and each step and finding names its `explorer`.
