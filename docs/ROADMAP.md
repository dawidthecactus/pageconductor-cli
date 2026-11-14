# PageConductor roadmap

## Architecture

```
CLI (Node / eventually TypeScript)
  -> Workflow engine (state machine; checkpoints; resumable runs)
  -> AI providers (OpenCode / Ollama / future Codex CLI)
  -> Component registries (shadcn / Magic UI / React Bits)
  -> Browser (Playwright CLI or MCP)
  -> Quality gates (ESLint, typecheck, Vitest, Playwright, LHCI, axe)
  -> Git integration (branch, diff, optional reviewed PR)
```

### M0.1: Working integrations
- [x] Command dispatch, help, version, doctor
- [x] Project configuration
- [x] Provider process adapters (OpenCode, Ollama)
- [x] Component installation adapter (shadcn registry)
- [x] Package script audit and JSON report
- [x] Explicit approval flags and clean Git gate
- [ ] Real-world smoke tests on Windows 11 PowerShell with OpenCode
- [ ] Real-world smoke tests for Ollama and shadcn registries

### M0.2: Reliable workflow runner
- [x] Persist runs in `.pageconductor/runs/` with progress, exit statuses, timestamps
- [ ] Project creation from explicitly selected templates
- [ ] Config/schema validation + setup wizard
- [ ] Automated Git worktree isolation
- [x] Preview plan -> approve -> build -> test -> review diff (OpenCode only, human gates)
- [x] Async subprocess adapter, fail-closed Windows shim resolver, mock process/transition tests
- [x] CI matrix for Windows/Linux Node 20/24 (execution pending first PR)
- [ ] Windows 11 end-to-end and process cancellation smoke tests (not verified yet)

Workflow architecture and recovery: [WORKFLOW.md](WORKFLOW.md).

### M0.3: Visual QA
- [ ] Playwright CLI snapshots & screenshots
- [ ] Axe accessibility tests and Lighthouse CI metrics
- [ ] Structured audit evidence and thresholds
- [ ] AI-assisted fix proposals using the audit evidence
- [ ] Compare before/after screenshots and enforce iteration cap

### M0.4: Plugin SDK and MCP
- [ ] Tool/plugin manifest with strict schemas and capability gating
- [ ] Opt-in MCP server connections (e.g., Playwright, shadcn)
- [ ] Model routing by cost and capability
- [ ] Result cache and model cost estimates
- [ ] Provider-independent tools and prompts

### M1.0: Team/public use
- [ ] npm packaging and releases; package name availability validation
- [ ] GitHub Actions, semantic versioning, changelog
- [ ] Documentation site and reproducible example portfolio
- [ ] Explicit opt-in GitHub PR and deployment adapters
- [ ] Sandboxing, allowlist security review, secret scanning

## Why this product?

Most AI coding tools generate code; PageConductor focuses on reproducible, reviewable workflows that **choose components, build code, run quality gates, and produce evidence**. Its distinguishing feature should be practical verification and human approvals, not a sprawling autonomous multi-agent chat.
