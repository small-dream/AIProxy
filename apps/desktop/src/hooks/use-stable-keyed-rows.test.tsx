import { act, render } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  useStableKeyedRows,
  type KeyedRowValue,
  type StableKeyedRow,
  type StableKeyedRowsApi,
} from "./use-stable-keyed-rows";

type Entry = KeyedRowValue;

// Mounts the hook inside <StrictMode> (mirrors main.tsx) with a parent that
// echoes each emitted array back as the `items` prop — the exact pattern the
// BreakpointInterceptPanel editors use.
//
// Access rows through `h.api` every time: the api object is reassigned on
// each Parent render, so a destructured `const { api }` would go stale.
function mountRows(initial: Entry[]) {
  const harness = {
    onChange: vi.fn(),
    api: null as unknown as StableKeyedRowsApi<Entry>,
    loadForeign: null as unknown as (entries: Entry[]) => void,
  };

  function Parent() {
    const [items, setItems] = useState(initial);
    harness.loadForeign = (entries: Entry[]) => setItems(entries.map((entry) => ({ ...entry })));
    const { rows, update, remove, add } = useStableKeyedRows<Entry>(items, (next) => {
      harness.onChange(next);
      setItems(next);
    });
    harness.api = { rows, update, remove, add };
    return (
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            {row.name}={row.value}
          </li>
        ))}
      </ul>
    );
  }

  render(
    <StrictMode>
      <Parent />
    </StrictMode>,
  );
  return harness;
}

type Harness = ReturnType<typeof mountRows>;

function lastEmit(h: Harness): Entry[] {
  return h.onChange.mock.calls.at(-1)?.[0] as Entry[];
}

describe("useStableKeyedRows (P1-16)", () => {
  it("emits onChange exactly once per update despite StrictMode double invocation", () => {
    const h = mountRows([{ name: "a", value: "1" }]);

    act(() => h.api.update(0, "value", "9"));

    // The pre-fix implementation emitted from inside the setRows updater,
    // which StrictMode invokes twice — one keystroke, two onChange calls.
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(lastEmit(h)).toEqual([{ name: "a", value: "9" }]);
    expect(h.api.rows[0]?.value).toBe("9");
  });

  it("emits exactly once per remove and per add", () => {
    const h = mountRows([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);

    act(() => h.api.remove(0));
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(lastEmit(h)).toEqual([{ name: "b", value: "2" }]);
    expect(h.api.rows).toHaveLength(1);

    act(() => h.api.add());
    expect(h.onChange).toHaveBeenCalledTimes(2);
    expect(lastEmit(h)).toEqual([
      { name: "b", value: "2" },
      { name: "", value: "" },
    ]);
    expect(h.api.rows).toHaveLength(2);
  });

  it("composes consecutive mutations in order without losing intermediate edits", () => {
    const h = mountRows([{ name: "a", value: "1" }]);

    // Rapid edits land before any re-render; each must build on the previous
    // one and each must emit exactly once, in call order.
    act(() => {
      h.api.update(0, "value", "12");
      h.api.update(0, "value", "123");
      h.api.add();
      h.api.remove(0);
    });

    expect(h.onChange).toHaveBeenCalledTimes(4);
    expect(h.onChange.mock.calls.map((call) => call[0])).toEqual([
      [{ name: "a", value: "12" }],
      [{ name: "a", value: "123" }],
      [
        { name: "a", value: "123" },
        { name: "", value: "" },
      ],
      [{ name: "", value: "" }],
    ]);
    expect(h.api.rows).toEqual([expect.objectContaining({ name: "", value: "" })]);
  });

  it("does not emit when updating an out-of-range index", () => {
    const h = mountRows([{ name: "a", value: "1" }]);

    act(() => h.api.update(5, "name", "x"));

    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.api.rows).toHaveLength(1);
  });

  it("keeps row ids stable when the parent echoes the emitted array back", () => {
    const h = mountRows([{ name: "a", value: "1" }]);
    const idsBefore = h.api.rows.map((row) => row.id);

    act(() => h.api.update(0, "value", "9"));

    // The echoed items array is a fresh reference containing exactly what we
    // emitted; the reset effect must treat it as our own emission and keep the
    // ids (regenerating them would drop input focus mid-edit).
    expect(h.api.rows.map((row) => row.id)).toEqual(idsBefore);
    expect(h.onChange).toHaveBeenCalledTimes(1);
  });

  it("regenerates ids only when the parent pushes foreign data", () => {
    const h = mountRows([{ name: "a", value: "1" }]);
    const idsBefore = h.api.rows.map((row) => row.id);

    act(() => h.loadForeign([{ name: "x", value: "y" }]));

    expect(h.api.rows).toHaveLength(1);
    expect(h.api.rows[0]?.name).toBe("x");
    expect(h.api.rows[0]?.id).not.toBe(idsBefore[0]);
  });

  it("strips local ids from emitted arrays while keeping them on local rows", () => {
    const h = mountRows([{ name: "a", value: "1" }]);

    act(() => h.api.add());

    for (const entry of lastEmit(h)) {
      expect(Object.hasOwn(entry, "id")).toBe(false);
    }
    // Local rows still carry ids for React keys.
    expect(h.api.rows.every((row) => Object.hasOwn(row as StableKeyedRow<Entry>, "id"))).toBe(true);
  });
});
