import generatedAbi from '../generated/lastlightVaultAbi.json';

/** ABI exported from the exact Foundry LastlightVault artifact. */
export const lastlightVaultAbi = generatedAbi;

export async function generatedAbiSha256(): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot verify the deployment ABI hash securely.');
  const bytes = new TextEncoder().encode(JSON.stringify(lastlightVaultAbi));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
