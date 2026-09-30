/**
 * Uniform random integer in [0, maxExclusive) with no modulo bias.
 *
 * Rejection sampling: 2^53 isn't a multiple of most ranges, so a naive
 * `getRandomValues % n` would over-represent the low values. For a video picker
 * the bias is invisible, but a wrong RNG in a "random" tool is the kind of bug
 * nobody ever finds, so it costs three lines to be correct.
 */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(`maxExclusive must be a positive integer, got ${maxExclusive}`);
  }
  if (maxExclusive === 1) return 0;

  const buf = new Uint32Array(2);
  const crypto = globalThis.crypto;

  // Common case: the range fits in one uint32, so use the low word directly and
  // reject anything at or above the largest exact multiple. Doing arithmetic on
  // a full 64-bit product in JS would silently lose precision past 2^53 and
  // reintroduce the very bias this is meant to avoid.
  if (maxExclusive <= 0x100000000) {
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    while (true) {
      crypto.getRandomValues(buf);
      if (buf[0]! < limit) return buf[0]! % maxExclusive;
    }
  }

  // Wide range: build a 53-bit value from 21 bits of the first word plus the
  // full second word. 21 + 32 = 53, the most a float64 integer can hold exactly.
  const limit = Math.floor(0x20000000000000 / maxExclusive) * maxExclusive;
  while (true) {
    crypto.getRandomValues(buf);
    const value = (buf[0]! >>> 11) * 0x100000000 + buf[1]!;
    if (value < limit) return value % maxExclusive;
  }
}

export function pickOne<T>(items: readonly T[]): T {
  if (items.length === 0) throw new RangeError("cannot pick from an empty array");
  return items[randomInt(items.length)]!;
}

/**
 * Pick `count` distinct items via a partial Fisher-Yates shuffle.
 *
 * O(count) rather than O(n*count) by only walking the prefix it needs, and
 * guarantees no duplicates up to n picks.
 */
export function pickMany<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (count > items.length) {
    throw new RangeError(`cannot pick ${count} unique items from ${items.length}`);
  }

  const pool = items.slice();
  const picked: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const j = i + randomInt(pool.length - i);
    const a = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = a;
    picked.push(pool[i]!);
  }
  return picked;
}
