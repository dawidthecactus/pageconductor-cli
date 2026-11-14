# PageConductor CLI 🧭

**A local-first AI-assisted website development orchestrator.**

> MVP v0.2.0. **Not** a complete autonomous website builder yet. This initial prototype integrates the OpenCode CLI and local Ollama planning, previews shadcn component installation, runs existing npm-based quality scripts, and checks for a clean Git worktree before an AI build.


## Workflow Engine v0.2 (approval-based)

The new `workflow` command combines **planning → human approval → build →
audit → review**, with a versioned checkpoint per run and SHA-256 plan approvals.

```powershell
# In an EXISTING trusted frontend Git repository:
pageconductor init
pageconductor workflow start "Build an accessible portfolio" --model openai/gpt-6-sol
pageconductor workflow start "Build an accessible portfolio" --model openai/gpt-6-sol --run
pageconductor workflow list
pageconductor workflow status <RUN_ID>
# Read the generated plan.md, then:
pageconductor workflow approve <RUN_ID> --digest <SHA256>
# Executes OpenCode build + available package.json quality scripts:
pageconductor workflow resume <RUN_ID>
pageconductor workflow review <RUN_ID>
pageconductor workflow review <RUN_ID> --accept
```

The first `start` is only a preview. The second calls AI to generate a plan.
**Never approve a plan without reading it.** On interrupted builds, `resume`
refuses to rerun the build; use explicit, manual recovery after checking Git.
No automatic commit/push/deploy actions occur. Full state model and recovery
instructions: [Workflow guide](docs/WORKFLOW.md).

## Prerequisites

- Node.js 20+ and Git
- Optional: [OpenCode](https://opencode.ai/docs/cli) (AI planning and building)
- Optional: [Ollama](https://docs.ollama.com/api/introduction) (read-only planning, local model already downloaded)
- Optional: npx and [shadcn CLI](https://ui.shadcn.com/docs/cli) in a Next.js/Tailwind project
- A trusted existing project with a `package.json`. The MVP does **not** scaffold a new Next.js project. For registry components, initialize shadcn/ui in the website project first (`npx shadcn@latest init`).

## Quick start (PowerShell)

```powershell
# From this repository:
npm test
npm link

# Use inside your EXISTING frontend repository:
cd "C:\path\to\my-portfolio"
pageconductor init
pageconductor doctor
pageconductor plan "Create a minimal portfolio homepage"          # Preview, no AI calls
pageconductor plan "Create a minimal portfolio homepage" --run    # OpenCode read-only plan
pageconductor component button                              # Preview
pageconductor component button --apply                      # Actually installs component
pageconductor audit                                         # Preview package scripts
pageconductor audit --run                                   # Run scripts, save report
pageconductor build "Create a beautiful projects section"         # Preview
pageconductor build "Create a beautiful projects section" --apply # Requires clean Git tree
```

Alternatively, skip global linking: `node C:\path\to\pageconductor-cli\bin\pageconductor.js --help`.

### Ollama planner

```powershell
# Install Ollama separately; pull a model before starting
ollama pull qwen2.5-coder:7b
pageconductor plan "Plan an accessible portfolio" --provider ollama --run
```

OpenCode can use many hosted and local models according to its configuration; PageConductor does not store API tokens.

## Feature status

| Feature | Status |
| --- | --- |
| CLI environment doctor | Working |
| Per-project `.pageconductor/config.json` | Working |
| OpenCode read-only planning | Adapter implemented, requires locally installed OpenCode |
| Local Ollama planning | Adapter implemented, requires local Ollama and pulled model |
| OpenCode build agent | Adapter implemented, explicit `--apply` and clean Git tree required |
| shadcn and compatible registries | Adapter implemented; registry namespaces are configured on installation, explicit `--apply` required |
| npm/pnpm/bun script audit with JSON report | Working, requires a trusted project and dependencies |
| Approval-based sequential workflow / persistent checkpoints | Working, real-provider Windows smoke pending |
| Multi-agent planning and automatic tool selection | Roadmap |
| Playwright and Lighthouse integrations | Roadmap |
| Automatic screenshot iteration and bug fixing | Roadmap |
| GitHub PR creation and deployment | Roadmap, explicit approval only |

**Status caveat:** The OpenCode, Ollama and shadcn integrations have not been exercised live in the test environment; the user has confirmed standalone OpenCode planning on Windows for v0.1. The new workflow and subprocess adapter still need Windows smoke tests. Automated tests cover the locally testable core. Follow real-project smoke tests before promising production compatibility.

## Safety

- AI planning/building and installation are opt-in, not automatic.
- `build --apply` refuses a dirty Git repository.
- All external tools run as separate processes, not a single composed shell command.
- Avoid running package scripts from untrusted projects.
- `plan --run` with OpenCode uses its `plan` agent. Configure OpenCode's own tool permissions in addition to this CLI. An instruction prompt is not a security sandbox.
- The source project, templates and UI component libraries may have different licenses. Do not redistribute third-party code blindly.
- No automatic commit, push, deployment, purchasing or token storage.
- Local AI prompts and reports are gitignored; report outputs may still contain sensitive data and should be reviewed before sharing.
- On Windows, subprocess commands resolve known `.cmd` shims to native `.exe` or Node entrypoints. Unrecognized shims fail closed; no `shell: true` argument interpolation.

## Windows test regression fix (0.1.1)

CLI subprocess tests use `fileURLToPath(new URL(...))` rather than `URL.pathname`.
On Windows, `URL.pathname` yields paths resembling `/C:/...`, which cause
Node.js to exit with code 1 even though the globally linked CLI works.
The tests also include subprocess stderr in failed assertions to ease troubleshooting.

## Development

```bash
npm test
npm run check
```

## Design and roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## License

MIT (PageConductor source only). Respect every external integration's license.
