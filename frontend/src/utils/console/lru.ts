/** Pure LRU helper over an ordered id list (most recent last). */

/**
 * Mark `id` as most recently used. Returns the new list and the ids that fell
 * off the front because the list exceeded `max`.
 */
export function touchLru(
  list: readonly string[],
  id: string,
  max: number,
): { list: string[]; evicted: string[] } {
  const next = list.filter((x) => x !== id);
  next.push(id);
  const evicted = next.length > max ? next.splice(0, next.length - max) : [];
  return { list: next, evicted };
}
