import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['js', 'shared', 'worker/src', 'tests', 'scripts'];
const extensions = new Set(['.js', '.mjs']);

function filesUnder(path){
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

const files = roots.flatMap(filesUnder).filter((file) => extensions.has(extname(file)));
for (const file of files){
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0){
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}

console.log(`Syntax check passed (${files.length} files).`);
