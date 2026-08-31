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
import { renderMigrationAudit } from './audit.js';
import { applyMigrationIgnores, renderMigrationIgnore } from './ignore.js';
import { applyMigration } from './migration.js';
import { classifyMigrationPortability, renderMigrationPortability } from './portability.js';
import { applyMigrationPortabilityFixes, renderMigrationPortabilityFix } from './portability_fix.js';
import { auditMigrationCommitReadiness } from './readiness.js';
import { execRegisteredResource, installedSkillrepoSupportsExec } from './runtime.js';

function usage(): never {
  console.error(`Usage:\n  skillrepo register <repo> [--no-verify]\n  skillrepo unregister <repo> [--no-verify]\n  skillrepo exec <repo-id> <repo-relative-resource> [args...]\n  skillrepo doctor\n  skillrepo migration apply --target-root <dir> [--plan <file>] [--execute] [--resume] [--no-verify]\n  skillrepo migration audit --target-root <dir> [--plan <file>] [--git <path>] [--json]\n  skillrepo migration ignore --target-root <dir> [--plan <file>] [--git <path>] [--execute]\n  skillrepo migration portability --target-root <dir> [--plan <file>] [--git <path>] [--json]\n  skillrepo migration portability fix --target-root <dir> [--plan <file>] [--git <path>] [--execute] [--json]`);
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

  if (command === 'exec') {
    if (rest.length < 2) usage();
    const [repoId, resource, ...args] = rest;
    const code = await execRegisteredResource({ repoId: repoId!, resource: resource!, args });
    process.exitCode = code;
    return;
  }

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

  if (command === 'migration') {
    const [subcommand, ...migrationArgs] = rest;

    if (subcommand === 'audit') {
      const { values, positionals } = parseArgs({
        args: migrationArgs,
        allowPositionals: true,
        allowNegative: true,
        options: {
          plan: { type: 'string', default: 'migration-plan.json' },
          'target-root': { type: 'string' },
          git: { type: 'string', default: 'git' },
          json: { type: 'boolean', default: false },
        },
      });
      if (positionals.length || !values['target-root']) usage();

      const result = await auditMigrationCommitReadiness({
        planPath: values.plan!,
        targetRoot: values['target-root'],
        gitPath: values.git!,
      });
      console.log(values.json ? JSON.stringify(result, null, 2) : renderMigrationAudit(result));
      return;
    }

    if (subcommand === 'ignore') {
      const { values, positionals } = parseArgs({
        args: migrationArgs,
        allowPositionals: true,
        allowNegative: true,
        options: {
          plan: { type: 'string', default: 'migration-plan.json' },
          'target-root': { type: 'string' },
          git: { type: 'string', default: 'git' },
          execute: { type: 'boolean', default: false },
        },
      });
      if (positionals.length || !values['target-root']) usage();

      const result = await applyMigrationIgnores({
        planPath: values.plan!,
        targetRoot: values['target-root'],
        gitPath: values.git!,
        dryRun: !values.execute,
      });
      console.log(renderMigrationIgnore(result));
      return;
    }

    if (subcommand === 'portability') {
      const [portabilitySubcommand, ...portabilityArgs] = migrationArgs;
      if (portabilitySubcommand === 'fix') {
        const { values, positionals } = parseArgs({
          args: portabilityArgs,
          allowPositionals: true,
          allowNegative: true,
          options: {
            plan: { type: 'string', default: 'migration-plan.json' },
            'target-root': { type: 'string' },
            git: { type: 'string', default: 'git' },
            execute: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
          },
        });
        if (positionals.length || !values['target-root']) usage();

        const preview = await applyMigrationPortabilityFixes({
          planPath: values.plan!,
          targetRoot: values['target-root'],
          gitPath: values.git!,
          dryRun: true,
        });
        let result = preview;
        if (values.execute) {
          const needsRuntimeExec = preview.files.some(file => file.actions.some(action => action.kind === 'AUTO-REPO-EXEC'));
          if (needsRuntimeExec && !(await installedSkillrepoSupportsExec())) {
            throw new Error(
              'Portability fix requires the current skillrepo CLI installed on PATH before rewriting MCP commands. '
              + 'Install this package globally, then re-run the same command.',
            );
          }
          result = await applyMigrationPortabilityFixes({
            planPath: values.plan!,
            targetRoot: values['target-root'],
            gitPath: values.git!,
            dryRun: false,
          });
        }
        console.log(values.json ? JSON.stringify(result, null, 2) : renderMigrationPortabilityFix(result));
        return;
      }

      const { values, positionals } = parseArgs({
        args: migrationArgs,
        allowPositionals: true,
        allowNegative: true,
        options: {
          plan: { type: 'string', default: 'migration-plan.json' },
          'target-root': { type: 'string' },
          git: { type: 'string', default: 'git' },
          json: { type: 'boolean', default: false },
        },
      });
      if (positionals.length || !values['target-root']) usage();

      const result = await classifyMigrationPortability({
        planPath: values.plan!,
        targetRoot: values['target-root'],
        gitPath: values.git!,
      });
      console.log(values.json ? JSON.stringify(result, null, 2) : renderMigrationPortability(result));
      return;
    }

    if (subcommand !== 'apply') usage();

    const { values, positionals } = parseArgs({
      args: migrationArgs,
      allowPositionals: true,
      allowNegative: true,
      options: {
        plan: { type: 'string', default: 'migration-plan.json' },
        'target-root': { type: 'string' },
        execute: { type: 'boolean', default: false },
        resume: { type: 'boolean', default: false },
        verify: { type: 'boolean', default: true },
      },
    });
    if (positionals.length || !values['target-root']) usage();

    const result = await applyMigration({
      planPath: values.plan!,
      targetRoot: values['target-root'],
      dryRun: !values.execute,
      resume: values.resume,
      verify: values.verify,
    });

    if (result.dryRun) {
      if (values.resume) {
        console.log(
          `Migration resume dry-run: ${result.moves.length} planned move(s), `
          + `${result.resumedMoves.length} already moved, `
          + `${result.moves.length - result.resumedMoves.length} pending into ${result.repositories.length} repo(s)`,
        );
      } else {
        console.log(`Migration dry-run: ${result.moves.length} move(s) into ${result.repositories.length} repo(s)`);
      }
      for (const move of result.moves) {
        const resumed = result.resumedMoves.some(item => item.target === move.target);
        console.log(`  ${resumed ? 'already-moved' : move.kind}: ${move.source} -> ${move.target}`);
      }
      console.log('No files were moved. Re-run with --execute only after reviewing this output.');
      return;
    }

    if (values.resume) {
      console.log(
        `Migration resumed: ${result.moves.length} planned move(s), `
        + `${result.resumedMoves.length} already moved into ${result.repositories.length} repo(s)`,
      );
    } else {
      console.log(`Migration applied: ${result.moves.length} move(s) into ${result.repositories.length} repo(s)`);
    }
    console.log(`Compatibility paths: ${result.compatibilityPaths.length}`);
    if (result.verification.length && !printVerification(result.verification)) {
      throw new Error('OpenCode verification failed after migration. Run skillrepo doctor for details.');
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
