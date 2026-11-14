import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  VERSION, parseArgs, projectRoot, readConfig, initProject, runProcess,
  toolAvailable, assertCleanRepo, validateComponent, savePrompt,
  detectManager, npmScriptCommand, availableAuditScripts, registerUIRegistries
} from './core.js';
import {
  startWorkflow, loadRun, listRuns, approveWorkflow, resumeWorkflow,
  recoverWorkflow, finishWorkflow, cancelWorkflow, runDirectory
} from './workflow.js';

const HELP = `PageConductor CLI v${VERSION} - AI-assisted website orchestration (MVP)

Usage:
  pageconductor doctor [--json]
  pageconductor init [--project DIR]
  pageconductor plan "GOAL" [--provider opencode|ollama] [--model NAME] [--run]
  pageconductor build "GOAL" [--model NAME] [--apply]
  pageconductor component NAME [--apply]
  pageconductor audit [--run]
  pageconductor workflow start "GOAL" [--model NAME] [--run]
  pageconductor workflow list | status RUN_ID
  pageconductor workflow approve RUN_ID --digest SHA256
  pageconductor workflow resume RUN_ID
  pageconductor workflow recover RUN_ID --choice retry-plan|acknowledge-build|retry-audit [--unlock]
  pageconductor workflow review RUN_ID [--accept]
  pageconductor workflow cancel RUN_ID

Global options for commands (except doctor): --project DIR

Safety: workflow start is preview-only unless --run; builds need explicit digest approval. No auto-push/deploy.
Examples:
  pageconductor init --project .
  pageconductor plan "Design a Power BI portfolio landing page" --run
  pageconductor component @react-bits/SplitText-TS-TW
  pageconductor component button --apply
  pageconductor audit --run
`;

function outputPlan(root, goal, opts, config) {
  const provider = opts.provider || config.provider;
  if (!['opencode', 'ollama'].includes(provider)) throw new Error('Provider must be opencode or ollama.');
  console.log(`PLAN | provider=${provider} | project=${root}`);
  console.log(`Goal: ${goal}`);
  if (!opts.run) {
    console.log('PREVIEW only. Add --run to call the AI provider.');
    return;
  }
  return (async () => {
    const file = savePrompt(root, 'plan', goal);
    const plans = join(root, '.pageconductor', 'plans');
    mkdirSync(plans, { recursive: true });
    let response;
    if (provider === 'opencode') {
      const argv = ['run', '--agent', 'plan', '--file', relative(root, file)];
      if (opts.model) {
        if (!/^[\w./:@+-]+$/.test(opts.model)) throw new Error('Invalid model identifier.');
        argv.push('--model', opts.model);
      }
      argv.push('Read the attached instructions and produce a stepwise implementation plan only. Do not change files.');
      console.log('Calling OpenCode plan agent...');
      const r = runProcess('opencode', argv, root, { capture: true });
      if (r.error || r.exitCode !== 0) throw new Error(`OpenCode failed: ${r.error || r.stderr}`);
      response = r.stdout;
    } else {
      const model = opts.model || config.ollamaModel;
      const controller = AbortSignal.timeout(120_000);
      console.log(`Calling local Ollama model ${model}...`);
      const result = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: `Create a READ-ONLY implementation plan for:\n${goal}\nDo not request secrets, deployment or deletion.`, stream: false }),
        signal: controller
      });
      if (!result.ok) throw new Error(`Ollama returned HTTP ${result.status}`);
      response = (await result.json()).response;
    }
    const dest = join(plans, `plan-${Date.now()}.md`);
    writeFileSync(dest, response + '\n', { flag: 'wx' });
    console.log(response);
    console.log(`\nSaved plan: ${dest}`);
  })();
}

function outputBuild(root, goal, opts) {
  console.log(`BUILD | project=${root}`);
  console.log(`Goal: ${goal}`);
  if (!opts.apply) {
    console.log('PREVIEW only. With --apply, OpenCode may change repository files.');
    console.log('Requires a clean Git working tree. No push, deploy, or commits are executed.');
    return;
  }
  assertCleanRepo(root);
  const file = savePrompt(root, 'build', goal);
  const argv = ['run', '--agent', 'build', '--file', relative(root, file)];
  if (opts.model) {
    if (!/^[\w./:@+-]+$/.test(opts.model)) throw new Error('Invalid model identifier.');
    argv.push('--model', opts.model);
  }
  argv.push('Implement the attached task. Do not push, deploy, make purchases, or read secrets. Report changes and tests.');
  console.log('Running OpenCode build agent. Review all diffs afterwards.');
  const r = runProcess('opencode', argv, root);
  if (r.error || r.exitCode !== 0) throw new Error(`OpenCode exited with code ${r.exitCode}: ${r.error || ''}`);
}

function outputComponent(root, id, opts) {
  validateComponent(id);
  console.log(`COMPONENT | ${id}`);
  console.log(`Command: npx shadcn@latest add ${id}${opts.apply ? '' : ' --dry-run'}`);
  console.log('Component license and dependencies are the responsibility of the caller.');
  if (!opts.apply) {
    console.log('PREVIEW only. Use --apply to install component(s).');
    return;
  }
  if (id.startsWith('@') && registerUIRegistries(root, id)) console.log(`Registered ${id.split('/')[0]} in components.json`);
  const r = runProcess('npx', ['--yes', 'shadcn@latest', 'add', id, '--yes'], root);
  if (r.error || r.exitCode !== 0) throw new Error(`shadcn add failed (${r.exitCode}): ${r.error || ''}`);
}

function outputAudit(root, opts, config) {
  const scripts = availableAuditScripts(root, config);
  const manager = detectManager(root, config);
  console.log(`AUDIT | manager=${manager}`);
  if (!scripts.length) {
    console.log('No recognized scripts: lint, typecheck, test, build.');
    return;
  }
  for (const s of scripts) console.log(`  ${manager} run ${s}`);
  if (!opts.run) {
    console.log('PREVIEW only. Use --run to execute package scripts.');
    console.log('CAUTION: package.json scripts are executable code; audit only trusted repositories.');
    return;
  }
  const checks = [];
  for (const script of scripts) {
    const [bin, args] = npmScriptCommand(manager, script);
    console.log(`\n>>> ${bin} ${args.join(' ')}`);
    const start = Date.now();
    const r = runProcess(bin, args, root, { capture: true });
    const entry = {
      script, command: [bin, ...args], exitCode: r.exitCode, durationMs: Date.now() - start,
      stdout: r.stdout.slice(-30000), stderr: r.stderr.slice(-30000), error: r.error ?? null
    };
    checks.push(entry);
    console.log(`${script}: ${r.exitCode === 0 ? 'PASS' : 'FAIL'} (${entry.durationMs}ms)`);
    if (r.exitCode !== 0) console.error((r.stderr || r.stdout || r.error || '').slice(-1500));
  }
  const dir = join(root, '.pageconductor', 'reports');
  mkdirSync(dir, { recursive: true });
  const report = join(dir, `audit-${Date.now()}.json`);
  writeFileSync(report, JSON.stringify({ timestamp: new Date().toISOString(), checks }, null, 2) + '\n');
  console.log(`Audit report: ${report}`);
  if (checks.some((c) => c.exitCode !== 0)) process.exitCode = 1;
}

async function outputWorkflow(root, positionals, options, config) {
  const [action, ...rest] = positionals;
  const id = rest[0];
  if (action === 'start') {
    if (options.provider && options.provider !== 'opencode') throw new Error('Workflow 0.2 supports OpenCode only. Standalone plan still supports Ollama.');
    const goal = rest.join(' ').trim();
    const run = await startWorkflow(root, goal, { model: options.model, run: !!options.run });
    if (run.preview) { console.log(`WORKFLOW PREVIEW | ${goal}\nUse --run to generate a plan. No files or AI calls made.`); return; }
    console.log(`Workflow ${run.id}: ${run.state}`);
    console.log(`Plan: ${join(runDirectory(root, run.id), 'plan.md')}`);
    console.log(`SHA256: ${run.planDigest}`);
    console.log(`Review the plan, then: pageconductor workflow approve ${run.id} --digest ${run.planDigest}`);
    return;
  }
  if (action === 'list') {
    const records = listRuns(root);
    if (!records.length) console.log('No workflows found.');
    else for (const record of records) console.log(`${record.id} | ${record.state} | ${record.goal.slice(0, 80)}`);
    return;
  }
  if (!id || rest.length !== 1) throw new Error('Specify exactly one workflow RUN_ID.');
  if (action === 'status') {
    const run = loadRun(root, id);
    console.log(JSON.stringify(run, null, 2));
    if (run.state === 'awaiting_approval') {
      console.log(`\nReview plan: ${join(runDirectory(root, id), 'plan.md')}`);
      console.log(`Approve: pageconductor workflow approve ${id} --digest ${run.planDigest}`);
    } else if (['building', 'auditing', 'planning'].includes(run.state)) {
      console.log('If the original process stopped, use explicit workflow recover. Never automatically rerun a build.');
    }
    return;
  }
  if (action === 'approve') {
    const run = await approveWorkflow(root, id, options.digest);
    console.log(`Approved plan ${run.planDigest} for ${id}.`);
    console.log(`To run build and audit: pageconductor workflow resume ${id}`);
    return;
  }
  if (action === 'resume') {
    const run = await resumeWorkflow(root, id, config);
    console.log(`Workflow ${id}: ${run.state}`);
    console.log(`Audit report: ${join(runDirectory(root, id), 'audit.json')}`);
    console.log(`Review: pageconductor workflow review ${id}`);
    return;
  }
  if (action === 'recover') {
    if (!options.choice) throw new Error('Recovery requires --choice retry-plan|acknowledge-build|retry-audit');
    const run = await recoverWorkflow(root, id, options.choice, config, {}, { unlock: !!options.unlock });
    console.log(`Recovered workflow ${id}: ${run.state}. Inspect artifacts before proceeding.`);
    return;
  }
  if (action === 'review') {
    const run = await finishWorkflow(root, id, { accept: !!options.accept });
    console.log(`Workflow ${id}: ${run.state}`);
    if (!options.accept) {
      console.log(`Audit: ${join(runDirectory(root, id), 'audit.json')}`);
      const gitStatus = runProcess('git', ['status', '--short'], root, { capture: true });
      const gitDiff = runProcess('git', ['diff', '--stat'], root, { capture: true });
      console.log('Git status:\n' + gitStatus.stdout);
      console.log('Diff summary:\n' + gitDiff.stdout);
      console.log(`If you accept the result: pageconductor workflow review ${id} --accept`);
    }
    return;
  }
  if (action === 'cancel') {
    const run = await cancelWorkflow(root, id);
    console.log(`Workflow ${id}: ${run.state}`);
    return;
  }
  throw new Error('Unknown workflow action. Use start, list, status, approve, resume, recover, review, cancel.');
}

export async function main(args) {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  if (cmd === '--version' || cmd === 'version') { console.log(VERSION); return; }
  const { positionals, options } = parseArgs(rest);
  if (cmd === 'doctor') {
    const checks = Object.fromEntries(['node', 'git', 'opencode', 'npx', 'pnpm', 'gh'].map((t) => [t, toolAvailable(t)]));
    if (options.json) console.log(JSON.stringify({ version: VERSION, tools: checks }, null, 2));
    else { console.log('PageConductor environment:'); for (const [name, ok] of Object.entries(checks)) console.log(`  ${ok ? 'OK  ' : 'MISS'} ${name}`); }
    return;
  }
  const root = projectRoot(options);
  if (cmd === 'init') {
    const created = initProject(root);
    console.log(created ? `Initialized: ${root}/.pageconductor/config.json` : `Already initialized: ${root}`);
    console.log('Updated project .gitignore for private prompts, plans and reports. Commit configuration before running AI build.');
    return;
  }
  const config = readConfig(root);
  if (cmd === 'workflow') return outputWorkflow(root, positionals, options, config);
  if (cmd === 'plan' || cmd === 'build') {
    const goal = positionals.join(' ').trim();
    if (!goal) throw new Error(`Provide a goal: pageconductor ${cmd} "..."`);
    if (cmd === 'plan') return outputPlan(root, goal, options, config);
    return outputBuild(root, goal, options);
  }
  if (cmd === 'component') {
    if (positionals.length !== 1) throw new Error('Provide one component identifier.');
    return outputComponent(root, positionals[0], options);
  }
  if (cmd === 'audit') return outputAudit(root, options, config);
  throw new Error(`Unknown command "${cmd}". Run pageconductor --help.`);
}
