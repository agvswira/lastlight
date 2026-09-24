#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const artifactPath = 'contracts/out/LastlightVault.sol/LastlightVault.json';
try {
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  if (!Array.isArray(artifact.abi)) throw new Error('Artifact has no ABI array.');
  await mkdir('src/generated', { recursive: true });
  await writeFile('src/generated/lastlightVaultAbi.json', JSON.stringify(artifact.abi, null, 2) + '\n');
  console.log(`Exported ${artifact.abi.length} ABI entries from ${artifactPath}`);
} catch (error) {
  console.error(`ABI export unavailable: compile with Foundry first (${artifactPath}).`);
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
}
