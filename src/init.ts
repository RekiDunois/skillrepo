import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const templateUrl = new URL('../../templates/opencode-migration.gitignore', import.meta.url);

export async function initRepo(inputPath: string, cwd = process.cwd()): Promise<string> {
  const target = resolve(cwd, inputPath);
  const template = await readFile(templateUrl, 'utf8');

  let targetExists = false;
  try {
    const stats = await lstat(target);
    targetExists = true;
    if (stats.isSymbolicLink()) throw new Error(`Refusing to initialize symlink path: ${target}`);
    if (!stats.isDirectory()) throw new Error(`Refusing to initialize non-directory path: ${target}`);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  if (targetExists && (await readdir(target)).length > 0) {
    throw new Error(`Refusing to initialize non-empty directory: ${target}`);
  }

  if (!targetExists) await mkdir(target, { recursive: true });
  await mkdir(resolve(target, 'skills'));
  await mkdir(resolve(target, 'agents'));
  await writeFile(resolve(target, '.gitignore'), template, { encoding: 'utf8', flag: 'wx' });
  await writeFile(resolve(target, 'skills', '.gitkeep'), '', { encoding: 'utf8', flag: 'wx' });
  await writeFile(resolve(target, 'agents', '.gitkeep'), '', { encoding: 'utf8', flag: 'wx' });

  return target;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
