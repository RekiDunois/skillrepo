import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const templateUrl = new URL('../../templates/opencode-migration.gitignore', import.meta.url);
export type InitLayout = 'apm' | 'legacy';

export async function initRepo(inputPath: string, cwd = process.cwd(), layout: InitLayout = 'apm'): Promise<string> {
  if (layout !== 'apm' && layout !== 'legacy') throw new Error(`Unsupported repository layout: ${layout}`);
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
  const sourceRoot = layout === 'apm' ? resolve(target, '.apm') : target;
  await mkdir(resolve(sourceRoot, 'skills'), { recursive: true });
  await mkdir(resolve(sourceRoot, 'agents'), { recursive: true });
  await writeFile(resolve(target, '.gitignore'), template, { encoding: 'utf8', flag: 'wx' });
  if (layout === 'apm') {
    const name = basename(target);
    const manifestName = /^[A-Za-z0-9._-]+$/.test(name) ? name : JSON.stringify(name);
    await writeFile(resolve(target, 'apm.yml'), `name: ${manifestName}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  await writeFile(resolve(sourceRoot, 'skills', '.gitkeep'), '', { encoding: 'utf8', flag: 'wx' });
  await writeFile(resolve(sourceRoot, 'agents', '.gitkeep'), '', { encoding: 'utf8', flag: 'wx' });

  return target;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
