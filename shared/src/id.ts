/**
 * UUID generation that works in Node, modern browsers and test environments without
 * assuming `crypto.randomUUID` exists.
 */
interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
}

export function randomUUID(): string {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b: number) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last resort — only reachable in exotic environments.
  return `x${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

/** Short, human-scannable id used for cluster labels: `PTN-4F2A`. */
export function shortId(prefix: string, seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).toUpperCase().padStart(8, '0').slice(0, 4)}`;
}
