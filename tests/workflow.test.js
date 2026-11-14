import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject, DEFAULT_CONFIG } from '../src/core.js';
import {
  startWorkflow, loadRun, runDirectory, listRuns, approveWorkflow,
  resumeWorkflow, recoverWorkflow, finishWorkflow, transition, sha256
} from '../src/workflow.js';
import { resolveCommand, runCommand } from '../src/process.js';

async function temp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pageconductor-workflow-'));
  try { initProject(root); return await fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function bootstrap(root, scripts = { test: 'node --version' }) {
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=PageConductor', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'initial']);
}
function fakeExecutor(log, { fail = null } = {}) {
  return async (bin, argv) => {
    const stage = bin === 'opencode' ? argv.includes('plan') ? 'plan' : 'build' : 'audit';
    log.push(stage);
    if (stage === fail) return { exitCode: 1, stderr: `${stage} error`, stdout: '', error: null };
    return { exitCode: 0, stdout: stage === 'plan' ? '# Approved implementation\n' : 'OK', stderr: '', error: null };
  };
}
async function planned(root, log = []) {
  return startWorkflow(root, 'Build an accessible portfolio', { run: true }, { execute: fakeExecutor(log) });
}

test('transition table rejects illegal paths and terminal changes', () => {
  const state = { state: 'planning' };
  assert.throws(() => transition(state, 'building'), /Invalid workflow transition/);
  transition(state, 'awaiting_approval');
  transition(state, 'approved');
  assert.throws(() => transition(state, 'complete'), /Invalid/);
  transition(state, 'building');
  transition(state, 'auditing');
  transition(state, 'awaiting_review');
  transition(state, 'complete');
  assert.throws(() => transition(state, 'cancelled'), /Invalid/);
});
test('preview is read-only, no runner and no checkpoint', () => temp(async (root) => {
  let count = 0;
  const result = await startWorkflow(root, 'Test', {}, { execute: () => { count++; } });
  assert.equal(result.preview, true);
  assert.deepEqual(listRuns(root), []);
  assert.equal(count, 0);
}));
test('persisted plan and SHA256 approval bind exact content, with no secrets in public git', () => temp(async (root) => {
  bootstrap(root);
  const log = [];
  const run = await planned(root, log);
  assert.deepEqual(log, ['plan']);
  assert.equal(run.state, 'awaiting_approval');
  assert.equal(listRuns(root).length, 1);
  assert.equal(loadRun(root, run.id).planDigest, run.planDigest);
  const path = join(runDirectory(root, run.id), 'plan.md');
  assert.equal(sha256(readFileSync(path)), run.planDigest);
  assert.throws(() => loadRun(root, '../../escape'), /Invalid workflow run ID/);
  await assert.rejects(approveWorkflow(root, run.id, 'bad'), /digest does not match/);
  writeFileSync(path, '# ATTACK\n');
  await assert.rejects(approveWorkflow(root, run.id, run.planDigest), /digest does not match/);
  assert.equal(loadRun(root, run.id).state, 'awaiting_approval');
  assert.equal(git(root, ['status', '--porcelain']), '');
}));
test('approved workflow builds once, audits and waits for explicit review', () => temp(async (root) => {
  bootstrap(root);
  const stages = [];
  const run = await planned(root, stages);
  await approveWorkflow(root, run.id, run.planDigest);
  const resumed = await resumeWorkflow(root, run.id, DEFAULT_CONFIG, { execute: fakeExecutor(stages) });
  assert.equal(resumed.state, 'awaiting_review');
  assert.deepEqual(stages, ['plan', 'build', 'audit']);
  assert.equal(JSON.parse(readFileSync(join(runDirectory(root, run.id), 'audit.json'))).checks.length, 1);
  await assert.rejects(resumeWorkflow(root, run.id, DEFAULT_CONFIG, { execute: fakeExecutor(stages) }), /cannot be resumed automatically/);
  assert.equal((await finishWorkflow(root, run.id)).state, 'awaiting_review');
  assert.equal((await finishWorkflow(root, run.id, { accept: true })).state, 'complete');
  assert.deepEqual(stages, ['plan', 'build', 'audit']);
}));
test('dirty repository blocks build without touching stage state', () => temp(async (root) => {
  bootstrap(root);
  const run = await planned(root);
  await approveWorkflow(root, run.id, run.planDigest);
  writeFileSync(join(root, 'scratch.txt'), 'not committed');
  const stages = [];
  await assert.rejects(resumeWorkflow(root, run.id, DEFAULT_CONFIG, { execute: fakeExecutor(stages) }), /Working tree has changes/);
  assert.deepEqual(stages, []);
  assert.equal(loadRun(root, run.id).state, 'approved');
}));
test('failed plan and failed build never trigger later stages', () => temp(async (root) => {
  bootstrap(root);
  const log = [];
  await assert.rejects(startWorkflow(root, 'Fail planning', { run: true }, { execute: fakeExecutor(log, { fail: 'plan' }) }), /planning failed/);
  assert.deepEqual(log, ['plan']);
  const run = await planned(root);
  await approveWorkflow(root, run.id, run.planDigest);
  const buildLog = [];
  await assert.rejects(resumeWorkflow(root, run.id, DEFAULT_CONFIG, { execute: fakeExecutor(buildLog, { fail: 'build' }) }), /build failed/);
  assert.deepEqual(buildLog, ['build']);
  assert.equal(loadRun(root, run.id).state, 'failed');
}));
test('audit failure stores report and never reaches review', () => temp(async (root) => {
  bootstrap(root);
  const run = await planned(root);
  await approveWorkflow(root, run.id, run.planDigest);
  const log = [];
  await assert.rejects(resumeWorkflow(root, run.id, DEFAULT_CONFIG, { execute: fakeExecutor(log, { fail: 'audit' }) }), /Audit failed/);
  assert.deepEqual(log, ['build', 'audit']);
  assert.equal(loadRun(root, run.id).state, 'failed');
  assert.equal(JSON.parse(readFileSync(join(runDirectory(root, run.id), 'audit.json'))).checks[0].exitCode, 1);
}));
test('interrupted build requires explicit recovery, never launches build twice', () => temp(async (root) => {
  bootstrap(root);
  const run = await planned(root);
  await approveWorkflow(root, run.id, run.planDigest);
  const data = loadRun(root, run.id);
  data.state = 'building';
  data.stages.building = { status: 'running' };
  // Simulate a crash after the durable stage checkpoint.
  const { saveRun } = await import('../src/workflow.js');
  saveRun(root, data);
  const events = [];
  await assert.rejects(resumeWorkflow(root, run.id, DEFAULT_CONFIG, { execute: fakeExecutor(events) }), /cannot be resumed automatically/);
  const recovered = await recoverWorkflow(root, run.id, 'acknowledge-build', DEFAULT_CONFIG, { execute: fakeExecutor(events) });
  assert.equal(recovered.state, 'awaiting_review');
  assert.deepEqual(events, ['audit']);
  assert.equal(recovered.stages.building.status, 'acknowledged');
}));
test('Windows shim resolution prefers native .exe and refuses ambiguous .cmd', () => temp(async (root) => {
  const bin = join(root, 'bin');
  mkdirSync(join(bin, 'node_modules', '@opencode', 'cli', 'bin'), { recursive: true });
  const shim = join(bin, 'opencode.cmd');
  const native = join(bin, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
  writeFileSync(shim, '@echo off\n');
  writeFileSync(native, 'stub');
  assert.equal(resolveCommand('opencode', { platform: 'win32', candidates: [shim] }).command, native);
  assert.throws(() => resolveCommand('bun', { platform: 'win32', candidates: [shim] }), /refusing to run/);
  assert.deepEqual(resolveCommand('git', { platform: 'win32', candidates: [] }), { command: 'git', argsPrefix: [] });
}));
test('async child runner captures output and detects nonzero exits', async () => {
  const ok = await runCommand(process.execPath, ['-e', 'console.log("hello")'], process.cwd());
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /hello/);
  const fail = await runCommand(process.execPath, ['-e', 'process.exit(7)'], process.cwd());
  assert.equal(fail.exitCode, 7);
});

test('changing an approved plan invalidates build authorization', () => temp(async (root) => {
  bootstrap(root);
  const run = await planned(root);
  await approveWorkflow(root, run.id, run.planDigest);
  writeFileSync(join(runDirectory(root, run.id), 'plan.md'), '# modified after approval\n');
  const events = [];
  await assert.rejects(resumeWorkflow(root, run.id, DEFAULT_CONFIG, { execute: fakeExecutor(events) }), /Approved plan changed/);
  assert.deepEqual(events, []);
  assert.equal(loadRun(root, run.id).state, 'approved');
}));
test('audit without recognized scripts records skipped and waits for review', () => temp(async (root) => {
  bootstrap(root, { check: 'node --version' });
  const run = await planned(root);
  await approveWorkflow(root, run.id, run.planDigest);
  const stages = [];
  const ended = await resumeWorkflow(root, run.id, DEFAULT_CONFIG, { execute: fakeExecutor(stages) });
  assert.equal(ended.state, 'awaiting_review');
  assert.equal(ended.stages.auditing.status, 'skipped');
  assert.deepEqual(stages, ['build']);
}));
test('stale lock needs explicit operator acknowledgement for recovery', () => temp(async (root) => {
  bootstrap(root);
  const run = await planned(root);
  await approveWorkflow(root, run.id, run.planDigest);
  const { saveRun } = await import('../src/workflow.js');
  const record = loadRun(root, run.id);
  record.state = 'building'; record.stages.building = { status: 'running' };
  saveRun(root, record);
  const lock = join(runDirectory(root, run.id), '.lock');
  writeFileSync(lock, 'stale');
  await assert.rejects(recoverWorkflow(root, run.id, 'acknowledge-build', DEFAULT_CONFIG), /Workflow lock exists/);
  const events = [];
  const recovered = await recoverWorkflow(root, run.id, 'acknowledge-build', DEFAULT_CONFIG,
    { execute: fakeExecutor(events) }, { unlock: true });
  assert.equal(recovered.state, 'awaiting_review');
  assert.deepEqual(events, ['audit']);
  assert.equal(existsSync(lock), false);
}));
test('runner enforces wall-clock timeout and output budget', async () => {
  const timeout = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], process.cwd(), { timeoutMs: 200 });
  assert.equal(timeout.timedOut, true);
  const output = await runCommand(process.execPath, ['-e', 'console.log("x".repeat(5000))'], process.cwd(), { maxOutputBytes: 1024 });
  assert.equal(output.truncated, true);
  assert.match(output.error, /Output exceeded/);
});
