/**
 * Reorder helpers for the rules list (R4b).
 *
 * The visible list is sorted by priority descending (top = highest). After a
 * drag we renumber the affected rules to `(N - index) * 10`, leaving a gap of
 * 10 between consecutive rules so manual integer edits can still slot between
 * them. Only rules whose priority actually changes are returned, so the bulk
 * update payload stays minimal.
 */
export function computeReorderedPriorities(
  orderedIds: string[],
  currentPriorities: Map<string, number>,
): Array<{ id: string; priority: number }> {
  const updates: Array<{ id: string; priority: number }> = [];
  const n = orderedIds.length;

  orderedIds.forEach((id, index) => {
    const next = (n - index) * 10;
    if (currentPriorities.get(id) !== next) {
      updates.push({ id, priority: next });
    }
  });

  return updates;
}
