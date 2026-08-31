#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  assertNoRuntimeCollisions,
  doctor,
  inspectRepo,
  registerRepo,
  unregisterRepo,
  verifyOpenCode,
  verifyRepoRegistered,
  verifyRepoUnregistered,
  type VerifyResult,
} from './core.js';

function usage(): never {
  console.error(`Usage:\n  skillrepo register <repo> [--no-verify]\n  skillrepo unregister <repo> [--no-verify]\n  skillrepo doctor`);
  process.exit(2);
}

function printVerification(results: VerifyResult[]): boolean {
  let ok = true;
  for (const result of results) {
    if (result.ok) {
      console.log(`✓ ${result.command}`);
    } else {
      ok = false;
      console.error(`✗ ${result.command}`);
      if (result.stderr.trim()) console.error(result.stderr.trim());
    }
  }
  return ok;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  if (command === 'register' || command === 'unregister') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      allowNegative: true,
      options: { verify: { type: 'boolean', default: true } },
    });
    if (positionals.length !== 1) usage();
    const repo = positionals[0]!;

    if (command === 'register') {
      const inventory = await inspectRepo(repo);
      if (values.verify) await assertNoRuntimeCollisions(inventory);

      const result = await registerRepo(repo);
      console.log(`Registered ${result.repo}`);
      if (result.skillPath) console.log(`  skills: ${result.skillPath}`);
      if (result.agentLink) console.log(`  agents: ${result.agentLink}`);

      if (values.verify) {
        const results = await verifyRepoRegistered(inventory);
        if (!printVerification(results)) {
          throw new Error('OpenCode post-check did not discover the registered repo. Registration changes were not rolled back. Run skillrepo doctor for details.');
        }
      }
      return;
    }

    const inventory = values.verify ? await inspectRepo(repo).catch(() => undefined) : undefined;
    await unregisterRepo(repo);
    console.log(`Unregistered ${repo}`);

    if (values.verify) {
      const results = inventory ? await verifyRepoUnregistered(inventory) : await verifyOpenCode();
      if (!printVerification(results)) {
        throw new Error('OpenCode post-check failed after unregister. Run skillrepo doctor for details.');
      }
    }
    return;
  }

  if (command === 'doctor') {
    if (rest.length) usage();
    const result = await doctor();
    if (result.issues.length === 0) console.log('skillrepo doctor: OK');
    else for (const issue of result.issues) console.error(`✗ ${issue}`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  usage();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
