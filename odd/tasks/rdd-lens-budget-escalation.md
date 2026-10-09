# RDD review escalation — lens budget deadlock for repos without lineage

> Filed by the orchestrator during the MFA reconcile of `quorum-backoffice`
> (PR #15). Route to the gentle-ai review-integration maintainer.
>
> **GitHub issue filed**: https://github.com/Gentleman-Programming/gentle-shell/issues/1985

## Summary

The native review controller **cannot review a repository that has no prior
review lineage** when the repository is larger than the reviewer lens context
budget. The first-review candidate is always scoped to the **entire repository**
(base = the empty root commit), so a repo above the budget can never pass its
first review — a deadlock.

## Repro

1. Repository with `repair.counts.lineages == 0` (no prior review).
2. `inspect` → `START` (ordinary) → terminal `lens_context_budget_exceeded`.
   Candidate = whole repo (~341 tracked files).
3. `START` with an explicit committed range
   `{"mode":"ordinary","baseRef":"<master tip>","committedOnly":true}` →
   **same** `lens_context_budget_exceeded`. The controller's derived
   `--base-ref` remains the empty root commit; the requested `baseRef` is not
   honored.

## Root cause

For a repo with no lineage, the controller derives `--base-ref` as the empty
root commit (`2799de579021cd94ffe23485eb8c35cdc18316b8`, "chore: initial empty
commit"), so the candidate is `empty → HEAD` (the whole repo) regardless of the
current branch or the requested `baseRef`. Because the lens budget is smaller
than the whole repo, the first review can never succeed, and no lineage is ever
created — which is exactly the precondition needed to scope a smaller diff.

## Concrete evidence

- `git diff --name-only master..HEAD | wc -l` → **74 files** (the actual MFA
  delta would fit well under budget).
- `git ls-files | wc -l` → **341 files** (whole repo, exceeds budget).
- Controller `inspect` `execute` always emits
  `--base-ref=2799de579021cd94ffe23485eb8c35cdc18316b8` (empty root) +
  `--committed-only=true`.
- `repair.counts.lineages = 0`.

## Requested fix (either)

1. **Honor an explicit `baseRef`** in START so the candidate is the committed
   range `baseRef..HEAD` (here: 74 files), not the whole repo.
2. **Add a bootstrap review** that establishes a lineage from a small slice
   (e.g. review one small commit as the initial baseline), after which
   subsequent reviews scope to the branch delta.

## Workaround used (partial)

The `intended_untracked_selection_required` stop was cleared by excluding build
artifacts (`apps/web/.next-tmp/`, `apps/web/playwright-report/`, `test-results/`)
via `.git/info/exclude`. The `managed_assets_outdated` stop was cleared with
`gentle-ai sync`. Only `lens_context_budget_exceeded` remains.
