# Changelog

## 0.2.0 (2026-11-14)

- Add approval-gated workflow (`start`, `list`, `status`, `approve`, `resume`, `review`, `cancel`).
- Add SHA-256 plan binding, local atomic checkpoints and explicit recovery choices.
- Add asynchronous subprocess executor and fail-closed Windows `.cmd` shim resolution instead of `shell: true`.
- Add Windows/Linux Node 20/24 CI matrix and workflow test coverage.
- Keep OpenCode workflow builds opt-in, require clean Git before build; never auto-push/deploy.

## 0.1.1

- Fix Windows test subprocess file path conversion.

## 0.1.0

- Initial CLI MVP with OpenCode/Ollama planning, shadcn component preview and package audit.
