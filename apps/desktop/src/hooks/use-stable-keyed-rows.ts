import { useCallback, useEffect, useRef, useState } from "react";

// Generic row shape: anything with the editable `name` / `value` pair. Concrete
// call sites use `HeaderEntry`; constraining here keeps the hook reusable while
// still letting mutators set `name`/`value` by field name.
export type KeyedRowValue = { name: string; value: string };

// Each row carries a LOCAL-only id used purely as the React key. Rows previously
// used `key={index}`, so deleting a middle row re-indexed the list and React
// reused DOM nodes by position — the wrong row's input state then bound to the
// shifted entries (focus jumps, values visually shuffle).
//
// The id survives the component's own edits (add/update/remove); it is
// regenerated only when the parent pushes an externally different `items`
// (e.g. a new intercepted request loaded, or a saved session selected). The id
// never leaves the hook: `onChange` still emits plain `T[]` (no id).
export type StableKeyedRow<T extends KeyedRowValue> = T & { id: string };

function sameValues<T extends KeyedRowValue>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i];
    return other !== undefined && entry.name === other.name && entry.value === other.value;
  });
}

function stripIds<T extends KeyedRowValue>(rows: StableKeyedRow<T>[]): T[] {
  // Drop the local id so callers receive the parent's value shape (e.g.
  // HeaderEntry[]), not the row. Each row was built by spreading a `T`
  // (`{ ...item, id }`), so shallow-cloning and deleting `id` restores the
  // original shape. TypeScript can't prove that for an arbitrary generic, so
  // the result is cast through `unknown`.
  return rows.map((row) => {
    const clone = { ...row } as Record<string, unknown> & T;
    delete clone.id;
    return clone as unknown as T;
  });
}

export type StableKeyedRowsApi<T extends KeyedRowValue> = {
  rows: StableKeyedRow<T>[];
  update: (index: number, field: "name" | "value", value: string) => void;
  remove: (index: number) => void;
  add: () => void;
};

/**
 * Mirrors a parent-supplied `items` array into local rows that each carry a
 * stable, component-local React key. Local edits mutate `rows` directly so the
 * keys (and therefore input focus) survive; the keys are regenerated only on an
 * external reset (when `items` differs from what we last emitted).
 *
 * @param items  Parent value of record (e.g. headers/query params).
 * @param onChange Callback invoked with the stripped (id-less) value on every
 *                 local mutation. Receives the SAME array shape the parent
 *                 passed in, so the contract is unchanged.
 */
export function useStableKeyedRows<T extends KeyedRowValue>(
  items: T[],
  onChange: (items: T[]) => void,
): StableKeyedRowsApi<T> {
  const [rows, setRows] = useState<StableKeyedRow<T>[]>(() =>
    items.map((item) => ({ ...item, id: crypto.randomUUID() })),
  );
  const lastEmittedRef = useRef<T[]>(items);

  // Keep a stable ref to the latest onChange so the memoized mutators below do
  // not need to depend on it (avoiding row re-creation on each parent render).
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Re-sync ids only when the parent provides a value we did not just emit
  // (an external reset), so we never bind a stale id to foreign data.
  useEffect(() => {
    if (sameValues(lastEmittedRef.current, items)) return;
    lastEmittedRef.current = items;
    setRows(items.map((item) => ({ ...item, id: crypto.randomUUID() })));
  }, [items]);

  const update = useCallback(
    (index: number, field: "name" | "value", value: string) => {
      setRows((prev) => {
        const current = prev[index];
        if (!current) return prev;
        const next = [...prev];
        next[index] = field === "name" ? { ...current, name: value } : { ...current, value };
        const stripped = stripIds(next);
        lastEmittedRef.current = stripped;
        onChangeRef.current(stripped);
        return next;
      });
    },
    [],
  );

  const remove = useCallback((index: number) => {
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== index);
      const stripped = stripIds(next);
      lastEmittedRef.current = stripped;
      onChangeRef.current(stripped);
      return next;
    });
  }, []);

  const add = useCallback(() => {
    setRows((prev) => {
      const next = [...prev, { name: "", value: "", id: crypto.randomUUID() } as StableKeyedRow<T>];
      const stripped = stripIds(next);
      lastEmittedRef.current = stripped;
      onChangeRef.current(stripped);
      return next;
    });
  }, []);

  return { rows, update, remove, add };
}
