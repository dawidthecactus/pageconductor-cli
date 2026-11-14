# Workflow Engine (M0.2)

PageConductor 0.2 adds an **approval-based orchestration loop** on top of the
existing standalone `plan`, `build`, `component`, and `audit` commands. At this
stage the workflow runner supports OpenCode; the standalone planner still
supports Ollama.

## Quick start (PowerShell)

Use an **existing trusted Git repository** with a committed, clean worktree,
`package.json`, and a configured OpenCode provider. The CLI does not yet scaffold
a new website.

```powershell
pageconductor init
# Inspect and commit .pageconductor/config.json and .gitignore if newly created.
git status --short
pageconductor workflow start "Create an accessible projects section" --model openai/gpt-6-sol
pageconductor workflow start "Create an accessible projects section" --model openai/gpt-6-sol --run
pageconductor workflow list
pageconductor workflow status <RUN_ID>
Get-Content ".pageconductor/runs/<RUN_ID>/plan.md"
# Review the contents carefully. Copy SHA256 from `status` or `start` output.
pageconductor workflow approve <RUN_ID> --digest <SHA256>
pageconductor workflow resume <RUN_ID>
pageconductor workflow review <RUN_ID>
# Check every changed file and test result before explicitly accepting:
pageconductor workflow review <RUN_ID> --accept
```

The `start` command is preview-only without `--run`. `approve` does **not**
launch a build. A separate `resume` command is required; it will refuse to
modify a dirty working tree. There are no automatic commits, pushes, PRs, or
deployments. Human review remains required.

All stages save checkpoints in `.pageconductor/runs/<RUN_ID>/state.json`. Plan
and audit artifacts live beside that file. The generated content is ignored by
Git. The plan is pinned by its SHA-256 digest. Editing it after approval
invalidates the authorization.

## States and transitions

```
planning -> awaiting_approval -> approved -> building -> auditing
                                                     -> awaiting_review -> complete
```

Any running stage can transition to `failed`. Paused stages can be cancelled.
Only the operator may resume an `approved` run. After a process crash, a saved
`planning`, `building`, or `auditing` state must be treated as **uncertain**.
Use `workflow status` to inspect it. `workflow resume` will not execute it.

## Recovery after interruption

Check that the old OpenCode process has fully stopped before recovery. If the
lock persists after a crash, add `--unlock` **only** after verifying the old
process is no longer running. The lock is never removed automatically.

```powershell
# Interrupted read-only plan: manually retry the planning call
pageconductor workflow recover <RUN_ID> --choice retry-plan

# Interrupted build: inspect Git changes first; NEVER auto-build again
# Then acknowledge existing build effects and run audits, without rebuilding
pageconductor workflow recover <RUN_ID> --choice acknowledge-build

# Interrupted audit: manually rerun trusted audit scripts
pageconductor workflow recover <RUN_ID> --choice retry-audit
```

If `.lock` is stale, append `--unlock` after verifying the original process
has stopped. A failed build or audit is a terminal `failed` run in this
milestone: fix its cause, commit/revert as needed, and start a new workflow.

## Security notes

- OpenCode is a powerful coding agent. Prompt instructions such as "don't read
  secrets" are **not** an operating-system security sandbox. Configure agent
  permissions and run only inside trusted repositories.
- Approval pins the plan file, not every possible OpenCode action. Review all
  diffs. A plan's contents can contain unsafe instructions.
- `audit` executes scripts from the project's `package.json`; trusted repos only.
- On Windows the subprocess adapter resolves known npm `.cmd` shims to their
  native `.exe` or Node entrypoints. It fails closed rather than passing argv
  through `cmd.exe` with `shell: true` (Node DEP0190).
- Automated tests use stub AI providers. Manual Windows smoke tests of OpenCode,
  npm/pnpm and cancellation are still required before production use.
- External provider authentication and any usage charges remain controlled by
  your provider setup. PageConductor does not store credentials.

## Scope deliberately not included

Template generation, Git worktrees, browser screenshots, Lighthouse, React
Bits component discovery, and automatic PRs are separate milestones.
