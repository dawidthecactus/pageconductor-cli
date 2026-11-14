import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, parseArgs, validateComponent, availableAuditScripts, initProject, registerUIRegistries } from '../src/core.js';

const entry = fileURLToPath(new URL('../bin/pageconductor.js', import.meta.url));
function cli(args, cwd) {
  return spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' });
}
function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pageconductor-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('argument parser handles named options and goals', () => {
  assert.deepEqual(parseArgs(['my goal', '--provider', 'ollama', '--run']), {
    positionals: ['my goal'], options: { provider: 'ollama', run: true }
  });
});
test('component parser accepts known shadcn registries and blocks shell-like strings', () => {
  assert.equal(validateComponent('@react-bits/SplitText-TS-TW'), '@react-bits/SplitText-TS-TW');
  assert.equal(validateComponent('@magicui/shimmer-button'), '@magicui/shimmer-button');
  assert.equal(validateComponent('button'), 'button');
  assert.throws(() => validateComponent('button; rm -rf .'));
  assert.throws(() => validateComponent('@untrusted/foo'));
});
test('init is idempotent and writes valid config', () => withTemp((root) => {
  assert.equal(initProject(root), true);
  assert.equal(initProject(root), false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.pageconductor/config.json'), 'utf8')), DEFAULT_CONFIG);
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /\.pageconductor\/prompts\//);
  assert.equal(ignore.split('.pageconductor/prompts/').length, 2);
}));
test('help and doctor work without dependencies', () => withTemp((root) => {
  const help = cli(['--help'], root);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /PageConductor/);
  const doctor = cli(['doctor', '--json'], root);
  assert.equal(doctor.status, 0);
  assert.equal(typeof JSON.parse(doctor.stdout).tools.git, 'boolean');
}));
test('commands preview actions without calling third-party services', () => withTemp((root) => {
  initProject(root);
  const plan = cli(['plan', 'A dark portfolio'], root);
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /PREVIEW only/);
  const build = cli(['build', 'New landing page'], root);
  assert.equal(build.status, 0);
  assert.match(build.stdout, /Requires a clean Git/);
  const component = cli(['component', '@react-bits/SplitText-TS-TW'], root);
  assert.equal(component.status, 0);
  assert.match(component.stdout, /PREVIEW only/);
}));
test('audit discovers allowlisted package scripts and writes pass report when run', () => withTemp((root) => {
  initProject(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', dangerous: 'exit 1' } }));
  assert.deepEqual(availableAuditScripts(root, DEFAULT_CONFIG), ['lint', 'test']);
  const preview = cli(['audit'], root);
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /npm run lint/);
  assert.doesNotMatch(preview.stdout, /dangerous/);
  const run = cli(['audit', '--run'], root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /lint: PASS/);
  assert.match(run.stdout, /test: PASS/);
}));

test('registry adapter updates only components.json when requested', () => withTemp((root) => {
  const file = join(root, 'components.json');
  writeFileSync(file, JSON.stringify({ aliases: { components: '@/components' } }));
  assert.equal(registerUIRegistries(root, '@magicui/bento-grid'), true);
  assert.equal(registerUIRegistries(root, '@magicui/marquee'), false);
  assert.equal(registerUIRegistries(root, '@react-bits/SplitText-TS-TW'), true);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(data.registries['@magicui'], 'https://magicui.design/r/{name}.json');
  assert.equal(data.registries['@react-bits'], 'https://reactbits.dev/r/{name}.json');
  assert.equal(data.aliases.components, '@/components');
}));

