import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm', 'opencode', 'bun']);

// Never run user-supplied argv through cmd.exe (Node DEP0190). Locate the real
// executable or the JS entry behind a known npm shim. Fail closed otherwise.
export function resolveCommand(bin, { platform = process.platform, candidates } = {}) {
  if (platform !== 'win32' || !WINDOWS_SHIMS.has(bin)) {
    return { command: bin, argsPrefix: [] };
  }
  const found = candidates ?? (() => {
    const r = spawnSync('where.exe', [bin], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  })();
  const direct = found.find((path) => /\.exe$/i.test(path));
  if (direct) return { command: direct, argsPrefix: [] };
  const shim = found.find((path) => /\.cmd$/i.test(path));
  if (!shim) throw new Error(`${bin} not found on Windows PATH.`);
  const parent = dirname(shim);
  const entries = {
    npm: [join(parent, 'node_modules', 'npm', 'bin', 'npm-cli.js')],
    npx: [join(parent, 'node_modules', 'npm', 'bin', 'npx-cli.js')],
    pnpm: [join(parent, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')],
    opencode: [join(parent, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')],
    bun: []
  };
  const entry = entries[bin].find(existsSync);
  if (!entry) {
    throw new Error(`Cannot resolve the native/JS entry for ${bin} (${shim}). Check its installation; refusing to run a .cmd shell shim.`);
  }
  if (/\.exe$/i.test(entry)) return { command: entry, argsPrefix: [] };
  return { command: process.execPath, argsPrefix: [entry] };
}

export function runProcess(bin, args, cwd, { capture = false, timeoutMs = 300_000 } = {}) {
  let resolved;
  try { resolved = resolveCommand(bin); }
  catch (error) { return { exitCode: 1, stdout: '', stderr: '', error: error.message }; }
  const r = spawnSync(resolved.command, [...resolved.argsPrefix, ...args], {
    cwd, encoding: 'utf8', shell: false, windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit', maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message,
    timedOut: r.error?.code === 'ETIMEDOUT'
  };
}

export function runCommand(bin, args, cwd, { timeoutMs = 300_000, maxOutputBytes = 2 * 1024 * 1024, signal } = {}) {
  let resolved;
  try { resolved = resolveCommand(bin); }
  catch (error) { return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', error: error.message }); }
  return new Promise((resolve) => {
    let stdout = '', stderr = '', error = null, timedOut = false, aborted = false;
    let received = 0, truncated = false;
    let child;
    try {
      child = spawn(resolved.command, [...resolved.argsPrefix, ...args], {
        cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal
      });
    } catch (err) {
      resolve({ exitCode: 1, stdout, stderr, error: err.message });
      return;
    }
    const collect = (type) => (chunk) => {
      received += chunk.length;
      if (received > maxOutputBytes) {
        truncated = true;
        child.kill();
        return;
      }
      if (type === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (err) => { error = err.message; aborted = err.name === 'AbortError'; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    timer.unref?.();
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr,
        error: truncated ? 'Output exceeded safety limit' : error, timedOut, aborted, truncated });
    });
  });
}
