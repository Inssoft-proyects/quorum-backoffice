---
name: quorum-pr-deliver
description: "Trigger: commit and PR, deliver to main, merge under branch protection, open a pull request. Branch, work-unit commits, push, open the PR and merge under branch protection."
license: Apache-2.0
metadata:
  author: inssoft-quorum
  version: "1.0"
---

## Activation Contract

Use when a Quorum change must land on `main` in a sibling repo protected by branch rules.

## Hard Rules

- Commit or push only on explicit user request; never commit unrelated foreign working-tree changes.
- Stage explicit paths only. Never `git add -A`/`git add .` in a tree with untracked foreign work.
- Bypassing branch protection (direct push or `--admin` merge) requires explicit user authorization.
- Publish (push/PR) only when the user asked to deliver.

## Decision Gates

| State | Action |
| --- | --- |
| behind `origin/main`, feature line open | branch off `origin/main` (clean, minimal PR) |
| PR requires review + linear history | rebase merge; `--admin` only if authorized |
| large multi-commit PR already open | prefer a small independent PR over growing it |
| dirty tree with foreign changes | isolate (worktree) before any edit |

## Execution Steps

1. Recon: `gh pr list --state open`, `gh api repos/<owner>/<repo>/branches/main/protection`.
2. Base a clean branch: `git worktree add <dir> -b <branch> origin/main` (isolated when the worktree is dirty).
3. Work-unit commits, Conventional Commit messages; one concern per commit.
4. Verify (tests/lint/typecheck) before pushing.
5. Push with an explicit refspec: `git push -u origin <branch>:<branch>` (guard against a `main` upstream).
6. `gh pr create --base main --head <branch>` with a body that lists commits + verification.
7. Merge: `gh pr merge <n> --rebase` (add `--admin` only with authorization); verify `main`; delete the branch.

## Output Contract

- PR URL, merge method, final commit SHA(s) on `main`, and confirmation that foreign work is untouched.

## References

- `gentle-ai` skills: `branch-pr`, `work-unit-commits`
