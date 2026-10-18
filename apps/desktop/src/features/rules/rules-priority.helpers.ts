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

/**
 * Priority every rule editor assigns to a brand-new draft. It is the neutral
 * placeholder the dirty check compares against, NOT the value a saved rule
 * ends up with: new rules land at the END of the list via
 * `resolveNewRulePriority` at save time.
 */
export const DEFAULT_RULE_PRIORITY = 100;

/**
 * Priority for a newly created rule that should land at the END of the list
 * (list order is priority: top = highest). One step below the current lowest
 * keeps the spacing scheme of `computeReorderedPriorities`; an empty list
 * starts at the historical default.
 */
export function nextAppendedPriority(existingPriorities: number[]): number {
  if (existingPriorities.length === 0) return DEFAULT_RULE_PRIORITY;
  return Math.min(...existingPriorities) - 10;
}

/**
 * Priority to persist when saving a draft.
 *
 * A brand-new rule appends at the END of the list, and that value is derived
 * from the CURRENT list at save time. Deriving it here (rather than baking it
 * into the draft at creation) is what keeps two things honest:
 * a new draft still matches the empty-rule baseline its dirty check compares
 * against, and a reorder performed while the draft was open cannot strand the
 * new rule in the middle of the list.
 *
 * `autoAssignedPriority` is the priority the editor handed the draft when it
 * was created. It only applies while the draft is new AND untouched: once the
 * rule exists on disk, or the user edits Priority in Advanced, the draft's own
 * value wins.
 */
export function resolveNewRulePriority<T extends { id: string; priority: number }>(
  draft: T,
  existing: T[],
  autoAssignedPriority: number | null,
): number {
  if (existing.some((rule) => rule.id === draft.id)) return draft.priority;
  if (autoAssignedPriority === null || draft.priority !== autoAssignedPriority) {
    return draft.priority;
  }
  return nextAppendedPriority(existing.map((rule) => rule.priority));
}

/**
 * Keyboard reorder (Alt+ArrowUp/ArrowDown): moves `ruleId` one slot within the
 * visible order. Returns the new ordered ids, or null when the move is a no-op
 * (unknown id, already at the boundary) so callers can skip the bulk update.
 */
export function moveRuleInOrder(
  orderedIds: string[],
  ruleId: string,
  direction: -1 | 1,
): string[] | null {
  const index = orderedIds.indexOf(ruleId);
  if (index < 0) return null;
  const target = index + direction;
  if (target < 0 || target >= orderedIds.length) return null;
  const next = [...orderedIds];
  next.splice(index, 1);
  next.splice(target, 0, ruleId);
  return next;
}

/**
 * Applies a reorder reported by the visible (possibly search-filtered) list to
 * the full rule array: visible items take their new relative order while items
 * hidden by the filter keep their slots. Needed where the persisted model IS
 * the ordered array itself (breakpoint rules: first match wins), unlike the
 * priority-numbered domains where only the affected rows are renumbered.
 */
export function applyOrderedIdsWithinList<T extends { id: string }>(
  all: T[],
  orderedIds: string[],
): T[] {
  const queue = [...orderedIds];
  return all.map((item) => {
    if (!orderedIds.includes(item.id)) return item;
    const nextId = queue.shift();
    return all.find((candidate) => candidate.id === nextId) ?? item;
  });
}
