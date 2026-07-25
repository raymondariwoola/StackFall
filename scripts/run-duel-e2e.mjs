import { spawn } from 'node:child_process';
import { request } from 'node:http';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const children = [];

function start(command, args, options = {}){
  const child = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  children.push(child);
  return child;
}

function probe(url){
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET' }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    req.setTimeout(500, () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function waitFor(url, child, timeoutMs){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline){
    if (child.exitCode !== null) throw new Error(`${url} server exited with code ${child.exitCode}`);
    if (await probe(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child){
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let exitCode = 1;
try {
  const worker = start(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--port', '8788',
    '--persist-to', '.wrangler/e2e',
  ], {
    cwd: path.join(ROOT, 'worker'),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(ROOT, '.wrangler-config'),
    },
  });
  const proxy = start(process.execPath, ['scripts/duel-dev-server.mjs']);
  await Promise.all([
    waitFor('http://127.0.0.1:8788/', worker, 30_000),
    waitFor('http://127.0.0.1:8137/', proxy, 15_000),
  ]);

  const playwright = start(process.execPath, [
    'node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2),
  ], {
    env: { ...process.env, STACKFALL_E2E_SERVERS: 'external' },
  });
  exitCode = await new Promise((resolve) => playwright.once('exit', (code) => resolve(code ?? 1)));
} catch (error){
  console.error(error instanceof Error ? error.message : error);
} finally {
  await Promise.all(children.slice(0, 2).map(stop));
}

process.exitCode = exitCode;
