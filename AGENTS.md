# Project Instructions

## Git: commit after edits to source files

After editing project source files, commit the change and push it to `main`.

**Scope — commit:**
- All tracked source changes (`.html`, `.js`, `api/`, `backend/`, `vendor/`, config)
- New untracked source files that belong to the app

**Scope — do not commit:**
- Test scripts and test artifacts (`test-*.js`, `*-test.js`, `test-*.js` under `backend/`)
- Log files (`tmp_*.log`, `*.log`)
- Generated output (`journal_output.png`, `calendar-preview.html`)
- Session notes (`session-summary.md`)
- PDFs (`*.pdf`)
- `node_modules`, anything already in `.gitignore`

**Process:**
1. `git status` + `git diff` to see exactly what changed.
2. Stage **only** the intended files — never `git add .` / `git add -A`.
3. Show the user the staged diff and **ask for confirmation before committing**.
4. On confirmation: commit with a concise message matching repo style (`fix: ...`, `feat: ...`), then `git push origin main`.
5. If the commit or push fails, fix and make a **new** commit — do not amend.

Never force-push, never push to another branch, never skip hooks.