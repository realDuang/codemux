# Agent Benchmark Prompt

Copy and paste the prompt below into any coding agent session (OpenCode, Claude Code, Copilot) to verify all tool capabilities work correctly.

## Design Principles

- **Idempotent**: Only creates `_benchmark_tmp.txt`, deleted before finish. Zero trace left.
- **Cross-platform**: Shell commands use `cat||type` and `rm||del` fallbacks.
- **Location-independent**: Discovers files dynamically (e.g. `*.json`), no hardcoded paths.
- **Minimal**: 17 steps covering 12 capabilities in ~60s.

## Coverage Matrix

| # | Capability | Type | Steps | Trigger |
|---|---|---|---|---|
| 1 | `todo` | tool | 1, 7, 12, 16 | direct (4x) |
| 2 | `list` | tool | 2 | direct |
| 3 | `glob` | tool | 3 | direct |
| 4 | `grep` | tool | 4 | direct |
| 5 | `read` | tool | 5 | direct |
| 6 | `web_fetch` | tool | 6 | direct |
| 7 | `write` | tool | 8 | direct |
| 8 | `edit` | tool | 9 | direct |
| 9 | `shell` | tool | 10, 15 | direct (2x) |
| 10 | `task` | tool | 11 | direct |
| 11 | `question` | interaction | 13 | forced ("You MUST ask me") |
| 12 | `reasoning` | output | 14 | induced (math reasoning) |

**Not tested in this prompt** (require UI automation — see `tests/e2e/specs/`):
- Permission approval (`permission.asked` / `permission.reply`)
- Message cancel (`message.cancel`) — see `message-cancel.spec.ts`
- Mode switch (`mode.set`) — see `mode-switch.spec.ts`
- Model switch (`model.set`)

---

## Prompt

```
Execute ALL tasks below in order. Do NOT skip any.

RULES:
- All created files MUST be deleted before you finish.
- Leave zero trace — the working directory must be identical before and after.

TASKS:

1. **TodoWrite**: Create a plan with ALL items below as pending, mark the first in_progress:
   "Explore" / "Search" / "Read" / "Web" / "Mutate" / "Delegate" / "Clarify" / "Cleanup"

2. **List**: List the current directory.

3. **Glob**: Find all `*.json` files recursively. Report count.

4. **Grep**: Search for `"name"` in any `.json` file found. Show first match.

5. **Read**: Read the first 10 lines of any file found in step 3.

6. **WebFetch**: Fetch `https://httpbin.org/get`. Confirm success.

7. **TodoWrite**: Mark steps 2-6 items completed, "Mutate" in_progress.

8. **Write**: Create `_benchmark_tmp.txt` with content `benchmark:ok`

9. **Edit**: Change `benchmark:ok` to `benchmark:verified` in `_benchmark_tmp.txt`.

10. **Shell**: Verify the edit — run `cat _benchmark_tmp.txt || type _benchmark_tmp.txt`

11. **Task**: Sub-agent — description: "verify benchmark", prompt: "Read _benchmark_tmp.txt, reply PASS if it contains 'verified', else FAIL."

12. **TodoWrite**: Mark "Mutate" and "Delegate" completed, "Clarify" in_progress.

13. **AskUser / Question**: You MUST ask me a question before proceeding. Ask which format I prefer for the final report, with options: "Table" / "JSON" / "One-liner". Wait for my answer, then use that format in step 16.

14. **Reasoning**: Think step-by-step (show your reasoning/thinking process) about this: "If an agent has 10 tools and each test step takes 2 seconds, but 4 steps can run in parallel, what is the minimum total time?" Show your work, then give the answer.

15. **Shell (cleanup)**: Delete `_benchmark_tmp.txt` — run `rm -f _benchmark_tmp.txt 2>/dev/null; del /f /q _benchmark_tmp.txt 2>nul; echo done`

16. **TodoWrite**: Mark ALL items completed.

17. **Final report**: Summarize (in the format I chose in step 13, default to table if I didn't answer):
    All 12 capabilities: shell, read, write, edit, grep, glob, list, web_fetch, task, todo, question, reasoning — each with invoked (Y/N) and step number.
```
