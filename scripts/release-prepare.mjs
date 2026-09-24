#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function hashFile(file) {
  try { return sha256(await readFile(file)); } catch { return null; }
}

async function walk(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) paths.push(...await walk(path));
      else paths.push(path);
    }
    return paths.sort();
  } catch { return []; }
}

async function hashTree(directory, { exclude = () => false } = {}) {
  const files = (await walk(directory)).filter((file) => !exclude(file));
  if (!files.length) return null;
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(`${file.slice(directory.length + 1)}\0`);
    digest.update(await readFile(file));
    digest.update('\n');
  }
  return digest.digest('hex');
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

function gitCommit() {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch { return null; }
}

async function artifactIdentity() {
  const artifactPath = 'contracts/out/LastlightVault.sol/LastlightVault.json';
  const artifact = await readJson(artifactPath);
  if (!artifact) {
    return { path: artifactPath, available: false, abiSha256: null, bytecodeSha256: null, runtimeBytecodeSha256: null };
  }
  const hashHex = (value) => {
    if (typeof value !== 'string' || !value) return null;
    const normalized = value.startsWith('0x') ? value.slice(2) : value;
    return /^[0-9a-f]+$/i.test(normalized) ? sha256(Buffer.from(normalized, 'hex')) : sha256(value);
  };
  return {
    path: artifactPath,
    available: true,
    abiSha256: sha256(JSON.stringify(artifact.abi ?? [])),
    bytecodeSha256: hashHex(artifact.bytecode?.object),
    runtimeBytecodeSha256: hashHex(artifact.deployedBytecode?.object),
  };
}

async function buildMetrics() {
  const files = (await walk('dist')).filter((file) => /\.(?:js|css|woff2?|html)$/.test(file));
  const assets = [];
  for (const file of files) {
    const contents = await readFile(file);
    assets.push({
      path: file,
      bytes: contents.byteLength,
      gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
    });
  }
  const html = await readFile('dist/index.html', 'utf8').catch(() => '');
  const initialPaths = [...html.matchAll(/(?:src|href)="(?:\.\/)?(assets\/[^"]+)"/g)].map((match) => `dist/${match[1]}`);
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const initialJavaScript = initialPaths
    .map((path) => byPath.get(path))
    .filter((asset) => asset?.path.endsWith('.js'));
  const fontAssets = assets.filter((asset) => /\.woff2?$/.test(asset.path));
  const jsAssets = assets.filter((asset) => asset.path.endsWith('.js'));
  const initialHomeJavaScriptGzipBytes = initialJavaScript.reduce((total, asset) => total + asset.gzipBytes, 0);
  const fontsBytes = fontAssets.reduce((total, asset) => total + asset.bytes, 0);
  return {
    distSha256: await hashTree('dist'),
    assets,
    initialHomeJavaScriptGzipBytes,
    totalJavaScriptGzipBytes: jsAssets.reduce((total, asset) => total + asset.gzipBytes, 0),
    fontsBytes,
    budgets: {
      initialHomeJavaScriptGzipBytes: { target: 180 * 1024, pass: initialHomeJavaScriptGzipBytes <= 180 * 1024 },
      fontsBytes: { target: 180 * 1024, pass: fontsBytes <= 180 * 1024 },
    },
  };
}

const manifests = ['deployments/968.json', 'deployments/677.json'];
const sourceFiles = [
  'contracts/src/LastlightVault.sol',
  'lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol',
  'lib/openzeppelin-contracts/OPENZEPPELIN_VERSION',
  'remappings.txt',
  'contracts/foundry.toml',
  'foundry.toml',
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.ts',
];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, await hashFile(file)])));
sourceHashes['src/'] = await hashTree('src');
sourceHashes['contracts/test/'] = await hashTree('contracts/test');
sourceHashes['scripts/'] = await hashTree('scripts');
sourceHashes['tests/'] = await hashTree('tests');
sourceHashes['deployments/'] = await hashTree('deployments');

const artifact = await artifactIdentity();
const build = await buildMetrics();
const performance = await readJson('evidence/local/performance.json');
const productionAudit = await readJson('evidence/local/production-audit.json');
const manifestRecords = {};
for (const file of manifests) {
  const manifest = await readJson(file);
  manifestRecords[file] = {
    sha256: await hashFile(file),
    chainId: manifest?.chainId ?? null,
    network: manifest?.network ?? null,
    contractAddress: manifest?.contractAddress ?? null,
    deploymentTimestamp: manifest?.deploymentTimestamp ?? null,
    verificationStatus: manifest?.verificationStatus ?? null,
  };
}

const evidenceDirectories = ['evidence/local', 'evidence/testnet', 'evidence/mainnet'];
const evidence = {};
for (const directory of evidenceDirectories) {
  evidence[directory] = {
    jsonSha256: await hashTree(directory, { exclude: (file) => !file.endsWith('.json') || file.endsWith('/release-prepare.json') }),
    jsonFiles: (await walk(directory)).filter((file) => file.endsWith('.json') && !file.endsWith('/release-prepare.json')),
  };
}

const release = {
  schemaVersion: 'lastlight.release-prepare.v2',
  generatedAt: new Date().toISOString(),
  gitCommit: gitCommit(),
  sourceHashes,
  compiler: {
    version: '0.8.30',
    evmVersion: 'paris',
    optimizer: true,
    optimizerRuns: 200,
    viaIr: false,
    foundryConfig: await hashFile('foundry.toml'),
  },
  artifact,
  frontendBuild: build,
  performance: performance ? {
    path: 'evidence/local/performance.json',
    measuredAt: performance.measuredAt ?? null,
    metrics: performance.metrics ?? null,
    budgets: performance.budgets ?? null,
    labOnly: true,
  } : null,
  productionAudit: productionAudit ? {
    path: 'evidence/local/production-audit.json',
    generatedAt: productionAudit.generatedAt ?? null,
    status: productionAudit.status ?? null,
    distSha256: productionAudit.distSha256 ?? null,
    failures: productionAudit.failures ?? [],
  } : null,
  manifests: manifestRecords,
  evidence,
  spendEstimate: {
    principalWei: null,
    gasBudgetWei: null,
    totalWei: null,
    status: 'OWNER_INPUT_REQUIRED',
    note: 'Set an explicit principal and gas budget after signer, network, and deployment scope are approved.',
  },
  runbook: [
    'Review compiler, artifact, frontend, manifest, and evidence hashes.',
    'Run npm run prod:audit after the production build and resolve any marker or asset failure before publishing.',
    'Run npm run preflight -- --network testnet and confirm the expected chain.',
    'Populate the deployment guard with the approved deployer, ABI/creation/runtime/source/config hashes, signer, and fee caps before any broadcast.',
    'Populate a deployment manifest only from an actual receipt and runtime bytecode.',
    'Run the guarded funded testnet lifecycle and verify evidence before enabling writes.',
    'For a frontend rollback, restore a previously hashed dist bundle; contract state and deadlines are never rolled back.',
  ],
  status: productionAudit?.status === 'PASS'
    ? 'READY_FOR_AUTHORIZED_ARTIFACT_AND_DEPLOYMENT_REVIEW'
    : 'LOCAL_PRODUCTION_AUDIT_REQUIRED',
  notes: [
    'This command does not broadcast or publish.',
    'Manifest addresses remain authoritative and currently null when no deployment evidence exists.',
    artifact.available
      ? 'Foundry artifact identity is present; reconcile it against the deployment receipt before broadcasting.'
      : 'A null artifact identity means Foundry output is not present in this workspace; run npm run contracts:build before deployment.',
  ],
};

await mkdir('evidence/local', { recursive: true });
await writeFile('evidence/local/release-prepare.json', JSON.stringify(release, null, 2) + '\n');
console.log(JSON.stringify(release, null, 2));
if (release.status !== 'READY_FOR_AUTHORIZED_ARTIFACT_AND_DEPLOYMENT_REVIEW') process.exitCode = 1;
