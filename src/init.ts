import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { renderOpenApmManifest } from './openapm.js';

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
  await writeFile(resolve(target, '.gitignore'), template, { encoding: 'utf8', flag: 'wx' });
  // The default APM skeleton is composition-neutral (issue #42): it contains
  // only the manifest and the ignore template. `.apm/`, root `skills/`, root
  // `agents/`, and placeholder files are created by generation and migration
  // once the package's primitive composition is actually known.
  if (layout === 'apm') {
    await writeFile(resolve(target, 'apm.yml'), renderOpenApmManifest(basename(target)), { encoding: 'utf8', flag: 'wx' });
    return target;
  }
  await mkdir(resolve(target, 'skills'), { recursive: true });
  await mkdir(resolve(target, 'agents'), { recursive: true });
  await writeFile(resolve(target, 'skills', '.gitkeep'), '', { encoding: 'utf8', flag: 'wx' });
  await writeFile(resolve(target, 'agents', '.gitkeep'), '', { encoding: 'utf8', flag: 'wx' });

  return target;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
