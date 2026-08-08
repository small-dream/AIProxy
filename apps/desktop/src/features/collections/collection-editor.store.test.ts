import { describe, it, expect, beforeEach } from "vitest";
import type { HeaderEntry } from "@aiproxy/shared-types";
import { useCollectionEditorStore } from "./collection-editor.store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildItem(
  overrides: Partial<{
    id: string;
    collectionId: string;
    name: string;
    description: string;
    method: string;
    url: string;
    headers: HeaderEntry[];
    body: string;
    bodyType: string;
    rawLanguage: string;
    formData: HeaderEntry[];
    urlEncoded: HeaderEntry[];
  }> = {},
) {
  return {
    id: overrides.id ?? "item-1",
    collectionId: overrides.collectionId ?? "col-1",
    name: overrides.name ?? "GET api.example.com",
    description: overrides.description ?? "",
    method: overrides.method ?? "GET",
    url: overrides.url ?? "https://api.example.com/users",
    headers: overrides.headers ?? [],
    body: overrides.body ?? "",
    bodyType: overrides.bodyType ?? "none",
    rawLanguage: overrides.rawLanguage ?? "json",
    formData: overrides.formData ?? [],
    urlEncoded: overrides.urlEncoded ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useCollectionEditorStore", () => {
  beforeEach(() => {
    useCollectionEditorStore.getState().reset();
  });

  // --- Initial state ---

  describe("initial state", () => {
    it("has correct defaults", () => {
      const state = useCollectionEditorStore.getState();
      expect(state.itemId).toBeNull();
      expect(state.collectionId).toBeNull();
      expect(state.name).toBe("");
      expect(state.method).toBe("GET");
      expect(state.url).toBe("");
      expect(state.bodyType).toBe("none");
      expect(state.rawLanguage).toBe("json");
      expect(state.headers).toEqual([]);
      expect(state.body).toBe("");
      expect(state.formDataEntries).toEqual([]);
      expect(state.urlEncodedEntries).toEqual([]);
    });
  });

  // --- loadFromItem ---

  describe("loadFromItem", () => {
    it("loads all fields from item", () => {
      const item = buildItem({
        id: "i-1",
        collectionId: "c-1",
        name: "POST users",
        description: "Create user",
        method: "POST",
        url: "https://api.example.com/users",
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: '{"name":"test"}',
        bodyType: "raw",
        rawLanguage: "json",
      });

      useCollectionEditorStore.getState().loadFromItem(item);
      const state = useCollectionEditorStore.getState();

      expect(state.itemId).toBe("i-1");
      expect(state.collectionId).toBe("c-1");
      expect(state.name).toBe("POST users");
      expect(state.description).toBe("Create user");
      expect(state.method).toBe("POST");
      expect(state.url).toBe("https://api.example.com/users");
      expect(state.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
      expect(state.body).toBe('{"name":"test"}');
      expect(state.bodyType).toBe("raw");
      expect(state.rawLanguage).toBe("json");
    });

    it("creates a defensive copy of headers and formData", () => {
      const headers: HeaderEntry[] = [{ name: "Authorization", value: "Bearer abc" }];
      const formData: HeaderEntry[] = [{ name: "file", value: "data" }];

      useCollectionEditorStore
        .getState()
        .loadFromItem(buildItem({ headers, bodyType: "formdata", formData }));

      const state = useCollectionEditorStore.getState();
      expect(state.headers).toEqual(headers);
      expect(state.headers).not.toBe(headers);
      expect(state.formDataEntries).toEqual(formData);
      expect(state.formDataEntries).not.toBe(formData);
    });

    // --- URL-encoded fallback parsing ---

    describe("url-encoded fallback parsing", () => {
      it("parses body into urlEncodedEntries when urlEncoded array is empty and bodyType is urlencoded", () => {
        useCollectionEditorStore.getState().loadFromItem(
          buildItem({
            body: "name=John&age=30",
            bodyType: "urlencoded",
            urlEncoded: [],
          }),
        );

        const state = useCollectionEditorStore.getState();
        expect(state.urlEncodedEntries).toEqual([
          { name: "name", value: "John" },
          { name: "age", value: "30" },
        ]);
      });

      it("uses structured urlEncoded entries when provided", () => {
        const urlEncoded: HeaderEntry[] = [{ name: "key", value: "val" }];

        useCollectionEditorStore.getState().loadFromItem(
          buildItem({
            body: "ignored=true",
            bodyType: "urlencoded",
            urlEncoded,
          }),
        );

        const state = useCollectionEditorStore.getState();
        expect(state.urlEncodedEntries).toEqual(urlEncoded);
      });

      it("does not parse body when bodyType is not urlencoded", () => {
        useCollectionEditorStore.getState().loadFromItem(
          buildItem({
            body: "name=John&age=30",
            bodyType: "raw",
            urlEncoded: [],
          }),
        );

        const state = useCollectionEditorStore.getState();
        expect(state.urlEncodedEntries).toEqual([]);
      });
    });

    // --- Migration logic ---

    describe("migration logic", () => {
      it("falls back bodyType from formdata to raw when no structured formData and body exists", () => {
        useCollectionEditorStore.getState().loadFromItem(
          buildItem({
            body: "raw-form-data-content",
            bodyType: "formdata",
            formData: [],
          }),
        );

        expect(useCollectionEditorStore.getState().bodyType).toBe("raw");
      });

      it("keeps formdata bodyType when structured formData entries exist", () => {
        useCollectionEditorStore.getState().loadFromItem(
          buildItem({
            body: "",
            bodyType: "formdata",
            formData: [{ name: "field", value: "val" }],
          }),
        );

        expect(useCollectionEditorStore.getState().bodyType).toBe("formdata");
      });

      it("falls back rawLanguage from json to text when migrated from formdata", () => {
        useCollectionEditorStore.getState().loadFromItem(
          buildItem({
            body: "some-content",
            bodyType: "formdata",
            rawLanguage: "json",
            formData: [],
          }),
        );

        const state = useCollectionEditorStore.getState();
        expect(state.bodyType).toBe("raw");
        expect(state.rawLanguage).toBe("text");
      });

      it("keeps rawLanguage when not migrated", () => {
        useCollectionEditorStore.getState().loadFromItem(
          buildItem({
            body: '{"data":1}',
            bodyType: "raw",
            rawLanguage: "json",
          }),
        );

        expect(useCollectionEditorStore.getState().rawLanguage).toBe("json");
      });
    });
  });

  // --- Setters ---

  describe("setters", () => {
    it("setName", () => {
      useCollectionEditorStore.getState().setName("New Name");
      expect(useCollectionEditorStore.getState().name).toBe("New Name");
    });

    it("setDescription", () => {
      useCollectionEditorStore.getState().setDescription("A description");
      expect(useCollectionEditorStore.getState().description).toBe("A description");
    });

    it("setMethod", () => {
      useCollectionEditorStore.getState().setMethod("POST");
      expect(useCollectionEditorStore.getState().method).toBe("POST");
    });

    it("setUrl", () => {
      useCollectionEditorStore.getState().setUrl("https://example.com");
      expect(useCollectionEditorStore.getState().url).toBe("https://example.com");
    });

    it("setBody", () => {
      useCollectionEditorStore.getState().setBody("request body");
      expect(useCollectionEditorStore.getState().body).toBe("request body");
    });

    it("setBodyType", () => {
      useCollectionEditorStore.getState().setBodyType("raw");
      expect(useCollectionEditorStore.getState().bodyType).toBe("raw");
    });

    it("setRawLanguage", () => {
      useCollectionEditorStore.getState().setRawLanguage("xml");
      expect(useCollectionEditorStore.getState().rawLanguage).toBe("xml");
    });

    it("setHeaders", () => {
      const headers: HeaderEntry[] = [{ name: "X-Custom", value: "test" }];
      useCollectionEditorStore.getState().setHeaders(headers);
      expect(useCollectionEditorStore.getState().headers).toEqual(headers);
    });

    it("setFormDataEntries", () => {
      const entries: HeaderEntry[] = [{ name: "file", value: "data" }];
      useCollectionEditorStore.getState().setFormDataEntries(entries);
      expect(useCollectionEditorStore.getState().formDataEntries).toEqual(entries);
    });

    it("setUrlEncodedEntries", () => {
      const entries: HeaderEntry[] = [{ name: "key", value: "val" }];
      useCollectionEditorStore.getState().setUrlEncodedEntries(entries);
      expect(useCollectionEditorStore.getState().urlEncodedEntries).toEqual(entries);
    });
  });

  // --- Reset ---

  describe("reset", () => {
    it("restores initial state after modifications", () => {
      const store = useCollectionEditorStore.getState();

      store.loadFromItem(
        buildItem({
          id: "i-1",
          collectionId: "c-1",
          name: "POST test",
          method: "POST",
          url: "https://example.com",
          headers: [{ name: "Auth", value: "token" }],
          body: "data",
          bodyType: "raw",
          rawLanguage: "text",
        }),
      );

      // Verify something was loaded
      expect(useCollectionEditorStore.getState().itemId).toBe("i-1");

      useCollectionEditorStore.getState().reset();

      const state = useCollectionEditorStore.getState();
      expect(state.itemId).toBeNull();
      expect(state.collectionId).toBeNull();
      expect(state.name).toBe("");
      expect(state.method).toBe("GET");
      expect(state.url).toBe("");
      expect(state.headers).toEqual([]);
      expect(state.body).toBe("");
      expect(state.bodyType).toBe("none");
      expect(state.rawLanguage).toBe("json");
      expect(state.formDataEntries).toEqual([]);
      expect(state.urlEncodedEntries).toEqual([]);
    });
  });
});
