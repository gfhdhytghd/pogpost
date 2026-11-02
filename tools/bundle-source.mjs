import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROOT_FILES = ['.env.example', '.gitignore', 'package.json', 'package-lock.json', 'README.md', 'SPEC.md', 'progress.md'];
const SOURCE_DIRS = ['server', 'engine', 'public', 'tools', 'test', 'deploy', 'docs', 'presets'];
const PRIVATE = /^(?:\.env(?:\..+)?|\.git|node_modules|data|runs|dist|testdata|private|secrets?|credentials?)(?:$)/i;
const SOURCE_TYPE = /\.(?:js|mjs|cjs|py|json|md|html|css|svg|woff2|example|template)$/i;

export async function sourceFiles(root = ROOT) {
  const files = [];
  async function walk(relative) {
    const entry = await lstat(path.join(root, relative));
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      for (const name of (await readdir(path.join(root, relative))).sort()) {
        if (PRIVATE.test(name) || name.startsWith('.')) continue;
        await walk(path.join(relative, name));
      }
    } else if (entry.isFile() && SOURCE_TYPE.test(relative)) files.push(relative);
  }
  for (const file of ROOT_FILES) {
    try { if ((await lstat(path.join(root, file))).isFile()) files.push(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const directory of SOURCE_DIRS) {
    try { await walk(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files.sort();
}

export async function bundleSource({ root = ROOT } = {}) {
  const files = await sourceFiles(root);
  if (!files.includes('package.json') || !files.some(file => file.startsWith('server/'))) throw Error('Source tree is incomplete.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sealed-source-'));
  try {
    for (const file of files) {
      const destination = path.join(temporary, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, file), destination);
    }
    await mkdir(path.join(root, 'dist'), { recursive: true });
    const artifact = path.join(root, 'dist/source.tar.gz');
    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', artifact, '-C', temporary, '.'], { env: { PATH: process.env.PATH }, stdio: 'ignore' });
    const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
    await writeFile(artifact + '.sha256', `${digest}  source.tar.gz\n`);
    return { artifact: 'dist/source.tar.gz', checksum: 'dist/source.tar.gz.sha256', files: files.length };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 2) throw Error('No arguments supported.');
    console.log(JSON.stringify(await bundleSource(), null, 2));
  } catch {
    console.error('Source bundling failed. Check the source tree and GNU tar installation.');
    process.exitCode = 1;
  }
}
