#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runAudit(args) {
  const result = spawnSync('npm', ['audit', '--json', ...args], { encoding: 'utf8' });
  let report;
  try {
    report = JSON.parse(result.stdout || '{}');
  } catch {
    report = { error: (result.stderr || result.stdout || 'npm audit returned no JSON').trim() };
  }
  const vulnerabilities = report.metadata?.vulnerabilities ?? null;
  return { exitCode: result.status ?? 1, vulnerabilities, error: report.error ?? null };
}

const lockfile = await readFile('package-lock.json');
const all = runAudit([]);
const production = runAudit(['--omit=dev']);
const status = all.vulnerabilities?.total === 0 && production.vulnerabilities?.total === 0 ? 'PASS' : 'FAIL';
const record = {
  schemaVersion: 'lastlight.dependency-audit.v1',
  generatedAt: new Date().toISOString(),
  packageLockSha256: sha256(lockfile),
  status,
  allDependencies: all,
  productionDependencies: production,
  note: 'The audit result is registry-backed evidence for the exact package-lock.json hash above; it does not replace source and license review.',
};

await mkdir('evidence/local', { recursive: true });
await writeFile('evidence/local/dependency-audit.json', JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
if (status !== 'PASS') process.exitCode = 1;
