import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import {
  assertCleanRepo, availableAuditScripts, detectManager, npmScriptCommand,
  runProcess, savePrompt
} from './core.js';
import { runCommand } from './process.js';

export const WORKFLOW_VERSION = 1;
export const TRANSITIONS = Object.freeze({
  planning: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'cancelled'],
  approved: ['building', 'cancelled'],
  building: ['auditing', 'failed', 'uncertain'],
  auditing: ['awaiting_review', 'failed', 'uncertain'],
  awaiting_review: ['complete', 'cancelled'],
  uncertain: ['planning', 'auditing', 'cancelled'],
  failed: ['cancelled'],
  cancelled: [], complete: []
});

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export function validateRunId(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid workflow run ID.');
  }
  return id;
}
export function runDirectory(root, id) {
  return join(root, '.pageconductor', 'runs', validateRunId(id));
}
const statePath = (root, id) => join(runDirectory(root, id), 'state.json');
function atomicJson(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { renameSync(temp, path); }
  finally { if (existsSync(temp)) rmSync(temp); }
}
export function newRun(root, goal, model) {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: WORKFLOW_VERSION, id: randomUUID(), root: resolve(root), goal,
    provider: 'opencode', model: model || null,
    createdAt: timestamp, updatedAt: timestamp, state: 'planning',
    gitHead: null, planDigest: null, approvedDigest: null,
    stages: {}, error: null
  };
}
function validateRun(run, root, id) {
  if (!run || run.schemaVersion !== WORKFLOW_VERSION || run.id !== id ||
      run.root !== resolve(root) || typeof run.goal !== 'string' || !TRANSITIONS[run.state] ||
      run.provider !== 'opencode' || typeof run.stages !== 'object' || !run.stages) {
    throw new Error('Invalid or incompatible checkpoint; refusing to execute.');
  }
  if (run.planDigest !== null && !/^[0-9a-f]{64}$/.test(run.planDigest)) {
    throw new Error('Invalid plan digest in checkpoint.');
  }
  if (run.approvedDigest !== null && !/^[0-9a-f]{64}$/.test(run.approvedDigest)) {
    throw new Error('Invalid approval digest in checkpoint.');
  }
  return run;
}
export function loadRun(root, id) {
  const data = JSON.parse(readFileSync(statePath(root, id), 'utf8'));
  return validateRun(data, root, id);
}
export function saveRun(root, run) {
  validateRun(run, root, run.id);
  run.updatedAt = new Date().toISOString();
  atomicJson(statePath(root, run.id), run);
  return run;
}
export function transition(run, state) {
  if (!TRANSITIONS[run.state]?.includes(state)) {
    throw new Error(`Invalid workflow transition: ${run.state} -> ${state}.`);
  }
  run.state = state;
  return run;
}
async function withLock(root, id, fn, { unlock = false } = {}) {
  const path = join(runDirectory(root, id), '.lock');
  if (unlock && existsSync(path)) rmSync(path);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (err) {
    if (err.code === 'EEXIST') throw new Error('Workflow lock exists. Check for an active process. Explicit recovery supports --unlock only after confirming the old process has stopped.');
    throw err;
  }
  try { return await fn(); }
  finally { closeSync(fd); rmSync(path, { force: true }); }
}
function checkModel(model) {
  if (model && !/^[\w./:@+-]+$/.test(model)) throw new Error('Invalid model identifier.');
}
function assertSuccess(result, label) {
  if (result.error || result.timedOut || result.aborted || result.exitCode !== 0) {
    throw new Error(`${label} failed (${result.exitCode ?? '?'}): ${String(result.error || result.stderr || 'Unknown error').slice(-1500)}`);
  }
}
function markStage(run, stage, status, additional = {}) {
  run.stages[stage] = { status, updatedAt: new Date().toISOString(), ...additional };
}
function fail(root, run, stage, err) {
  markStage(run, stage, 'failed', { error: err.message });
  run.error = { stage, message: err.message };
  transition(run, 'failed');
  saveRun(root, run);
}
function gitHead(root) {
  const out = runProcess('git', ['rev-parse', 'HEAD'], root, { capture: true });
  assertSuccess(out, 'git rev-parse HEAD');
  return out.stdout.trim();
}
const executor = (dependencies) => dependencies.execute ?? runCommand;

async function planStage(root, run, execute) {
  markStage(run, 'planning', 'running');
  saveRun(root, run);
  try {
    const prompt = savePrompt(root, 'plan', `${run.goal}\n\nReturn a detailed, read-only implementation plan. Never modify project files.`);
    const args = ['run', '--agent', 'plan', '--file', relative(root, prompt)];
    if (run.model) args.push('--model', run.model);
    args.push('Read attached instructions. Produce a step-by-step plan only. Do not modify files.');
    const result = await execute('opencode', args, root);
    assertSuccess(result, 'OpenCode planning');
    if (!result.stdout.trim()) throw new Error('OpenCode returned an empty plan.');
    const text = result.stdout.trimEnd() + '\n';
    const path = join(runDirectory(root, run.id), 'plan.md');
    writeFileSync(path, text, { mode: 0o600 });
    run.planDigest = sha256(text);
    markStage(run, 'planning', 'passed', { artifact: '.pageconductor/runs/' + run.id + '/plan.md' });
    transition(run, 'awaiting_approval');
    saveRun(root, run);
    return run;
  } catch (err) { fail(root, run, 'planning', err); throw err; }
}
export async function startWorkflow(root, goal, { model, run = false } = {}, dependencies = {}) {
  if (!goal || !goal.trim()) throw new Error('Workflow requires a goal.');
  checkModel(model);
  if (!run) return { preview: true, goal, model: model ?? null };
  const record = newRun(root, goal.trim(), model);
  const dir = runDirectory(root, record.id);
  mkdirSync(dir, { recursive: true });
  saveRun(root, record);
  return withLock(root, record.id, () => planStage(root, record, executor(dependencies)));
}
export function listRuns(root) {
  const parent = join(root, '.pageconductor', 'runs');
  if (!existsSync(parent)) return [];
  return readdirSync(parent).filter((name) => {
    try { validateRunId(name); return true; } catch { return false; }
  }).map((id) => {
    try { const r = loadRun(root, id); return { id, state: r.state, goal: r.goal }; }
    catch { return { id, state: 'invalid', goal: '' }; }
  });
}
export async function approveWorkflow(root, id, digest) {
  return withLock(root, id, async () => {
    const run = loadRun(root, id);
    if (run.state !== 'awaiting_approval') throw new Error('Workflow is not awaiting approval.');
    const actual = sha256(readFileSync(join(runDirectory(root, id), 'plan.md')));
    if (!digest || digest !== actual || digest !== run.planDigest) {
      throw new Error('Plan digest does not match. Read plan.md and pass --digest <SHA256> from workflow status.');
    }
    run.approvedDigest = actual;
    transition(run, 'approved');
    return saveRun(root, run);
  });
}
async function buildAndAudit(root, run, execute, config, { skipBuild = false } = {}) {
  if (!skipBuild) {
    assertCleanRepo(root);
    if (run.gitHead && gitHead(root) !== run.gitHead) throw new Error('Git HEAD changed since workflow approval.');
    const plan = readFileSync(join(runDirectory(root, run.id), 'plan.md'), 'utf8');
    if (!run.planDigest || run.planDigest !== sha256(plan) || run.approvedDigest !== run.planDigest) {
      throw new Error('Approved plan changed; refusing to build.');
    }
    run.gitHead = gitHead(root);
    transition(run, 'building');
    markStage(run, 'building', 'running');
    saveRun(root, run);
    try {
      const prompt = savePrompt(root, 'build', `${run.goal}\n\nApproved plan (SHA256 ${run.planDigest}):\n${plan}\n\nOnly implement the approved work. Do not commit, push or deploy.`);
      const args = ['run', '--agent', 'build', '--file', relative(root, prompt)];
      if (run.model) args.push('--model', run.model);
      args.push('Implement the attached approved plan. Do not push, commit, deploy, make purchases, or read secrets.');
      const result = await execute('opencode', args, root);
      assertSuccess(result, 'OpenCode build');
      markStage(run, 'building', 'passed');
      transition(run, 'auditing');
      saveRun(root, run);
    } catch (err) { fail(root, run, 'building', err); throw err; }
  }
  markStage(run, 'auditing', 'running');
  saveRun(root, run);
  const scripts = availableAuditScripts(root, config);
  const manager = detectManager(root, config);
  const checks = [];
  try {
    for (const script of scripts) {
      const [bin, argv] = npmScriptCommand(manager, script);
      const result = await execute(bin, argv, root);
      checks.push({ script, exitCode: result.exitCode, error: result.error ?? null,
        stdout: (result.stdout || '').slice(-30000), stderr: (result.stderr || '').slice(-30000),
        timedOut: !!result.timedOut, aborted: !!result.aborted });
      if (result.exitCode !== 0 || result.error || result.timedOut || result.aborted) break;
    }
    atomicJson(join(runDirectory(root, run.id), 'audit.json'), { checks, manager, timestamp: new Date().toISOString() });
    if (checks.some((c) => c.exitCode !== 0 || c.error || c.timedOut || c.aborted)) throw new Error('Audit failed; inspect audit.json.');
    markStage(run, 'auditing', scripts.length ? 'passed' : 'skipped', { checks: checks.length });
    transition(run, 'awaiting_review');
    saveRun(root, run);
    return run;
  } catch (err) { fail(root, run, 'auditing', err); throw err; }
}
export async function resumeWorkflow(root, id, config, dependencies = {}) {
  return withLock(root, id, async () => {
    const run = loadRun(root, id);
    if (run.state !== 'approved') {
      throw new Error(`Workflow in state ${run.state} cannot be resumed automatically. Use explicit recovery for interrupted stages.`);
    }
    return buildAndAudit(root, run, executor(dependencies), config);
  });
}
export async function recoverWorkflow(root, id, choice, config, dependencies = {}, { unlock = false } = {}) {
  if (!['retry-plan', 'acknowledge-build', 'retry-audit'].includes(choice)) throw new Error('Explicit recovery choice required.');
  return withLock(root, id, async () => {
    const run = loadRun(root, id);
    if (!['planning', 'building', 'auditing', 'uncertain'].includes(run.state)) {
      throw new Error(`Recovery is only for interrupted stages, not ${run.state}.`);
    }
    const stage = run.state === 'uncertain' ? run.stages.building?.status === 'running' ? 'building' :
      run.stages.auditing?.status === 'running' ? 'auditing' : 'planning' : run.state;
    if (choice === 'retry-plan' && stage === 'planning') {
      // Previous planning is read-only by contract, but provider permissions still apply.
      run.planDigest = null; run.approvedDigest = null;
      run.state = 'planning';
      return planStage(root, run, executor(dependencies));
    }
    if (choice === 'acknowledge-build' && stage === 'building') {
      // Never rerun an uncertain build. Human confirms prior build effects before auditing.
      if (run.approvedDigest !== run.planDigest ||
          sha256(readFileSync(join(runDirectory(root, id), 'plan.md'))) !== run.planDigest) {
        throw new Error('Approved plan no longer matches; cannot recover.');
      }
      markStage(run, 'building', 'acknowledged');
      run.state = 'auditing';
      saveRun(root, run);
      return buildAndAudit(root, run, executor(dependencies), config, { skipBuild: true });
    }
    if (choice === 'retry-audit' && stage === 'auditing') {
      run.state = 'auditing';
      return buildAndAudit(root, run, executor(dependencies), config, { skipBuild: true });
    }
    throw new Error(`Recovery action ${choice} does not match interrupted stage ${stage}.`);
  }, { unlock });
}
export async function finishWorkflow(root, id, { accept = false } = {}) {
  return withLock(root, id, async () => {
    const run = loadRun(root, id);
    if (run.state !== 'awaiting_review') throw new Error('Workflow is not awaiting review.');
    if (!accept) return run;
    transition(run, 'complete');
    return saveRun(root, run);
  });
}
export async function cancelWorkflow(root, id) {
  return withLock(root, id, async () => {
    const run = loadRun(root, id);
    if (!['awaiting_approval', 'approved', 'awaiting_review', 'failed'].includes(run.state)) {
      throw new Error('Cannot cancel an actively running or completed workflow.');
    }
    transition(run, 'cancelled');
    return saveRun(root, run);
  });
}
