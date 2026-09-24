import { keccak_256 } from '@noble/hashes/sha3';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): value is `0x${string}` {
  return ADDRESS_PATTERN.test(value.trim());
}

export function isZeroAddress(value: string): boolean {
  return isAddress(value) && /^0x0{40}$/i.test(value);
}

export function hasBadMixedChecksum(value: string): boolean {
  if (!isAddress(value) || value === value.toLowerCase() || value === value.toUpperCase()) return false;
  const lower = value.slice(2).toLowerCase();
  const digest = keccak_256(new TextEncoder().encode(lower));
  for (let index = 0; index < lower.length; index += 1) {
    const character = value[index + 2];
    if (!/[a-f]/i.test(character)) continue;
    const hashByte = digest[Math.floor(index / 2)];
    const hashNibble = index % 2 === 0 ? hashByte >> 4 : hashByte & 0x0f;
    if ((hashNibble >= 8) !== (character === character.toUpperCase())) return true;
  }
  return false;
}

export function shortAddress(value: string, start = 6, end = 4): string {
  if (!value) return 'Not connected';
  if (value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

export function normalizeAddress(value: string): `0x${string}` | null {
  const trimmed = value.trim();
  return isAddress(trimmed) ? (`0x${trimmed.slice(2).toLowerCase()}` as `0x${string}`) : null;
}
