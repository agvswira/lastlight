#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const distDirectory = 'dist';
const outputPath = process.env.LASTLIGHT_PRODUCTION_AUDIT_OUTPUT ?? 'evidence/local/production-audit.json';

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
  } catch {
    return [];
  }
}

async function fileText(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

async function hashTree(files) {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(`${file.slice(distDirectory.length + 1)}\0`);
    digest.update(await readFile(file));
    digest.update('\n');
  }
  return digest.digest('hex');
}

const files = await walk(distDirectory);
const indexPath = `${distDirectory}/index.html`;
const html = await fileText(indexPath);
const checks = {};
const failures = [];

function record(name, pass, details) {
  checks[name] = { pass, ...details };
  if (!pass) failures.push(name);
}

record('indexHtml', html !== null && html.includes('<noscript>') && !html.includes('/src/main.ts'), {
  path: indexPath,
  hasStaticFallback: html?.includes('<noscript>') ?? false,
  hasSourceEntry: html?.includes('/src/main.ts') ?? false,
});

const localReferences = html
  ? [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((reference) => reference.startsWith('./') || reference.startsWith('assets/'))
  : [];
const missingReferences = localReferences
  .map((reference) => reference.replace(/^\.\//, ''))
  .filter((reference) => !files.includes(`${distDirectory}/${reference}`));
record('assetReferences', missingReferences.length === 0, {
  references: localReferences,
  missing: missingReferences,
});

const entryReference = html?.match(/<script(?=[^>]*\btype="module")(?=[^>]*\bsrc="([^"]+)")[^>]*>/)?.[1];
const entryPath = entryReference?.replace(/^\.\//, '');
const entryText = entryPath ? await fileText(`${distDirectory}/${entryPath}`) : null;
const modulePreloadReferences = html
  ? [...html.matchAll(/<link(?=[^>]*\brel="modulepreload")(?=[^>]*\bhref="([^"]+)")[^>]*>/g)].map((match) => match[1])
  : [];
const staticInitialImports = entryText
  ? [...entryText.matchAll(/(?:^|[;\n])import\s*(?:[^('"`]+?\s*from\s*)?["']([^"']+)["']/g)].map((match) => match[1])
  : [];
const eagerRuntimeImports = staticInitialImports.filter((reference) => /(?:viem|chain|wallet|read|write|client|receipts|proof|ccip)/i.test(reference));
record('lazyChainAndProofChunks', entryText !== null && modulePreloadReferences.length === 0 && eagerRuntimeImports.length === 0, {
  entry: entryReference ?? null,
  modulePreloadReferences,
  staticInitialImports,
  eagerRuntimeImports,
  note: 'Wallet, chain, read/write, receipt, and proof modules must be requested through route or user interaction imports.',
});

const secretLikeFiles = files.filter((file) => /(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.(?:pem|key|seed|mnemonic))$/i.test(file));
record('secretLikeFiles', secretLikeFiles.length === 0, { files: secretLikeFiles });

const scannedFiles = files.filter((file) => /\.(?:html|css|js)$/.test(file) && !file.endsWith('.map'));
const scannedContents = await Promise.all(scannedFiles.map(async (file) => ({ file, text: await readFile(file, 'utf8') })));
const markerRules = [
  { name: 'browser test hooks', pattern: /__lastlightTest|LASTLIGHT_E2E/ },
  { name: 'private key helpers', pattern: /privateKeyToAccount/ },
  { name: 'test signer', pattern: /0xf39f[d-f0-9]{34,}/i },
  { name: 'development gallery runtime', pattern: /Component gallery|renderComponentGallery|gallery-action-dialog|component-gallery|__components/ },
];
const markerMatches = [];
for (const rule of markerRules) {
  for (const asset of scannedContents) {
    if (rule.pattern.test(asset.text)) markerMatches.push({ rule: rule.name, file: asset.file });
  }
}
record('runtimeMarkers', markerMatches.length === 0, {
  scannedFiles,
  matches: markerMatches,
  allowedConfiguration: ['Local Anvil', '31337', '127.0.0.1:8545', 'testnet', 'mainnet'],
});

const sourceMapFiles = files.filter((file) => file.endsWith('.map'));
record('sourceMaps', sourceMapFiles.length > 0, {
  files: sourceMapFiles,
  note: 'Source maps are retained for local review; production publishing should omit them unless the release policy explicitly allows them.',
});

const evidence = {
  schemaVersion: 'lastlight.production-audit.v1',
  generatedAt: new Date().toISOString(),
  mode: 'local production build',
  distSha256: files.length ? await hashTree(files) : null,
  checks,
  status: failures.length ? 'FAIL' : 'PASS',
  failures,
  note: 'This gate checks the built artifact locally. It does not prove hosted-domain headers, public reachability, or a published deployment.',
};

await mkdir('evidence/local', { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (failures.length) process.exitCode = 1;
