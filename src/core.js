import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const VERSION = '0.1.0';
export const DEFAULT_CONFIG = {
  version: 1,
  provider: 'opencode',
  ollamaModel: 'qwen2.5-coder:7b',
  framework: 'nextjs',
  packageManager: 'auto',
  auditScripts: ['lint', 'typecheck', 'test', 'build']
};

export function parseArgs(args) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (!/^[a-z][a-z-]*$/.test(key)) throw new Error(`Invalid option: ${arg}`);
      if (inline !== undefined) options[key] = inline;
      else if (['project', 'provider', 'model'].includes(key)) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
        options[key] = args[++i];
      } else options[key] = true;
    } else positionals.push(arg);
  }
  return { positionals, options };
}

export function projectRoot(options) { return resolve(String(options.project || '.')); }
export function configPath(root) { return join(root, '.pageconductor', 'config.json'); }
export function readConfig(root) {
  if (!existsSync(configPath(root))) throw new Error(`Not initialized: ${root}\nRun: pageconductor init --project "${root}"`);
  const config = JSON.parse(readFileSync(configPath(root), 'utf8'));
  if (config.version !== 1) throw new Error('Unsupported configuration version');
  return { ...DEFAULT_CONFIG, ...config };
}
export function initProject(root) {
  if (!existsSync(root)) throw new Error(`Directory does not exist: ${root}`);
  const dir = join(root, '.pageconductor');
  mkdirSync(dir, { recursive: true });
  const created = !existsSync(configPath(root));
  if (created) writeFileSync(configPath(root), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { flag: 'wx' });
  // Keep local prompts and audit logs out of public GitHub repos by default.
  const gitignore = join(root, '.gitignore');
  const ignoreLines = ['.pageconductor/prompts/', '.pageconductor/plans/', '.pageconductor/reports/'];
  const original = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const missing = ignoreLines.filter((x) => !original.split(/\r?\n/).includes(x));
  if (missing.length) {
    const separator = original.length > 0 && !original.endsWith('\n') ? '\n' : '';
    appendFileSync(gitignore, separator + '# PageConductor generated local data\n' + missing.join('\n') + '\n');
  }
  return created;
}


// User-controlled arguments are passed as argv, never interpolated into a shell string.
// On Windows the npm/opencode shims are .cmd; allow shell only for a carefully fixed
// command + strictly validated operands (prompts are attached as files).
export function runProcess(bin, args, cwd, { capture = false } = {}) {
  const windowsShim = process.platform === 'win32' && ['npm', 'pnpm', 'npx', 'opencode', 'bun'].includes(bin);
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    shell: windowsShim,
    stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message
  };
}
export function toolAvailable(bin) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [bin], { encoding: 'utf8', stdio: 'pipe' });
  return r.status === 0;
}
export function gitDirty(root) {
  const isRepo = runProcess('git', ['rev-parse', '--is-inside-work-tree'], root, { capture: true });
  if (isRepo.exitCode !== 0 || isRepo.stdout.trim() !== 'true') throw new Error('Build requires a Git repository. Run git init and commit the initial project first.');
  const status = runProcess('git', ['status', '--porcelain'], root, { capture: true });
  if (status.exitCode !== 0) throw new Error('Cannot determine Git status.');
  return status.stdout.trim().length > 0;
}
export function assertCleanRepo(root) {
  if (gitDirty(root)) throw new Error('Working tree has changes. Commit or stash first; the AI build will not touch a dirty repository.');
}
export function validateComponent(id) {
  if (!/^[a-zA-Z0-9@/._-]+$/.test(id)) throw new Error('Invalid component identifier.');
  if (id.startsWith('@')) {
    if (!['@magicui/', '@react-bits/'].some((p) => id.startsWith(p))) {
      throw new Error('Only @magicui/* and @react-bits/* registries are enabled in this MVP.');
    }
    if (id.split('/')[1]?.length < 2) throw new Error('Missing registry component name.');
  } else if (id.includes('/')) throw new Error('Use an approved registry prefix or a basic shadcn component name.');
  return id;
}
export function savePrompt(root, mode, goal) {
  const dir = join(root, '.pageconductor', 'prompts');
  mkdirSync(dir, { recursive: true });
  const id = randomUUID().slice(0, 12);
  const path = join(dir, `${mode}-${id}.md`);
  const text = `# PageConductor ${mode} instructions\n\n## User goal\n${goal}\n\n## Rules\n- Work only inside this repository.\n- Never access .env files or secrets.\n- Never push, deploy, or make purchases.\n- Do not add private assets or credentials.\n- Preserve existing architecture and accessibility.\n- For a plan: do not modify application files.\n- For a build: implement incremental changes; report files and tests.\n`;
  writeFileSync(path, text, { flag: 'wx' });
  return path;
}
export function detectManager(root, config) {
  if (config.packageManager !== 'auto') {
    if (!['npm', 'pnpm', 'bun'].includes(config.packageManager)) throw new Error('Unsupported package manager');
    return config.packageManager;
  }
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}
export function npmScriptCommand(manager, script) {
  return manager === 'npm' ? ['npm', ['run', script]] : [manager, ['run', script]];
}
export function availableAuditScripts(root, config) {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const scripts = data.scripts || {};
  return config.auditScripts.filter((s) => ['lint', 'typecheck', 'test', 'build'].includes(s) && typeof scripts[s] === 'string');
}

export const UI_REGISTRIES = Object.freeze({
  '@magicui': 'https://magicui.design/r/{name}.json',
  '@react-bits': 'https://reactbits.dev/r/{name}.json'
});

export function registerUIRegistries(root, componentId) {
  if (!componentId.startsWith('@')) return false;
  const namespace = componentId.split('/')[0];
  const url = UI_REGISTRIES[namespace];
  if (!url) throw new Error(`Unsupported registry: ${namespace}`);
  const file = join(root, 'components.json');
  if (!existsSync(file)) throw new Error('components.json missing. Initialize shadcn/ui first: npx shadcn@latest init');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.registries ??= {};
  if (config.registries[namespace]) return false;
  config.registries[namespace] = url;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return true;
}
