import { describe, it, expect, beforeEach } from "vitest";
import type { HeaderEntry } from "@aiproxy/shared-types";
import { useComposeEditorStore } from "./compose-editor.store";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useComposeEditorStore", () => {
  beforeEach(() => {
    useComposeEditorStore.getState().reset();
  });

  // --- Initial state ---

  describe("initial state", () => {
    it("has correct defaults", () => {
      const state = useComposeEditorStore.getState();
      expect(state.method).toBe("GET");
      expect(state.url).toBe("");
      expect(state.headers).toEqual([]);
      expect(state.body).toBe("");
      expect(state.bodyType).toBe("none");
      expect(state.rawLanguage).toBe("json");
      expect(state.formDataEntries).toEqual([]);
      expect(state.urlEncodedEntries).toEqual([]);
      expect(state.activeTab).toBe("headers");
    });
  });

  // --- loadFromSession ---

  describe("loadFromSession", () => {
    it("loads method, url, and headers", () => {
      const headers: HeaderEntry[] = [{ name: "Accept", value: "application/json" }];
      useComposeEditorStore.getState().loadFromSession({
        method: "POST",
        url: "https://api.example.com/data",
        headers,
      });

      const state = useComposeEditorStore.getState();
      expect(state.method).toBe("POST");
      expect(state.url).toBe("https://api.example.com/data");
      expect(state.headers).toEqual(headers);
      expect(state.headers).not.toBe(headers);
    });

    // --- Content-type inference ---

    describe("content-type inference", () => {
      it("infers bodyType as raw when body is provided without explicit bodyType", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          body: '{"key": "value"}',
        });

        expect(useComposeEditorStore.getState().bodyType).toBe("raw");
      });

      it("infers bodyType as none when no body and no explicit bodyType", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "GET",
          url: "https://api.example.com",
          headers: [],
        });

        expect(useComposeEditorStore.getState().bodyType).toBe("none");
      });

      it("uses explicit bodyType when provided", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          body: "a=1&b=2",
          bodyType: "urlencoded",
        });

        expect(useComposeEditorStore.getState().bodyType).toBe("urlencoded");
      });

      it("defaults body to empty string when not provided", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "GET",
          url: "https://api.example.com",
          headers: [],
        });

        expect(useComposeEditorStore.getState().body).toBe("");
      });

      it("defaults rawLanguage to json when not provided", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          body: "<xml/>",
          bodyType: "raw",
        });

        expect(useComposeEditorStore.getState().rawLanguage).toBe("json");
      });
    });

    // --- Active tab inference ---

    describe("active tab inference", () => {
      it("sets activeTab to body when bodyType is raw", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          body: "data",
          bodyType: "raw",
        });

        expect(useComposeEditorStore.getState().activeTab).toBe("body");
      });

      it("sets activeTab to body when bodyType is formdata", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          bodyType: "formdata",
        });

        expect(useComposeEditorStore.getState().activeTab).toBe("body");
      });

      it("sets activeTab to headers when bodyType is none", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "GET",
          url: "https://api.example.com",
          headers: [],
        });

        expect(useComposeEditorStore.getState().activeTab).toBe("headers");
      });
    });

    // --- Form data entries ---

    describe("form data entries", () => {
      it("creates defensive copy of formDataEntries", () => {
        const formData: HeaderEntry[] = [{ name: "field", value: "val" }];
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          bodyType: "formdata",
          formDataEntries: formData,
        });

        const state = useComposeEditorStore.getState();
        expect(state.formDataEntries).toEqual(formData);
        expect(state.formDataEntries).not.toBe(formData);
      });

      it("creates defensive copy of urlEncodedEntries", () => {
        const urlEncoded: HeaderEntry[] = [{ name: "key", value: "val" }];
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          bodyType: "urlencoded",
          urlEncodedEntries: urlEncoded,
        });

        const state = useComposeEditorStore.getState();
        expect(state.urlEncodedEntries).toEqual(urlEncoded);
        expect(state.urlEncodedEntries).not.toBe(urlEncoded);
      });

      it("defaults formDataEntries to empty array when not provided", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          bodyType: "formdata",
        });

        expect(useComposeEditorStore.getState().formDataEntries).toEqual([]);
      });

      it("defaults urlEncodedEntries to empty array when not provided", () => {
        useComposeEditorStore.getState().loadFromSession({
          method: "POST",
          url: "https://api.example.com",
          headers: [],
          bodyType: "urlencoded",
        });

        expect(useComposeEditorStore.getState().urlEncodedEntries).toEqual([]);
      });
    });
  });

  // --- Form state reset ---

  describe("reset", () => {
    it("restores all fields to initial state", () => {
      const store = useComposeEditorStore.getState();

      store.loadFromSession({
        method: "DELETE",
        url: "https://api.example.com/resource/1",
        headers: [{ name: "Auth", value: "token" }],
        body: '{"force":true}',
        bodyType: "raw",
        rawLanguage: "json",
        formDataEntries: [{ name: "a", value: "b" }],
        urlEncodedEntries: [{ name: "c", value: "d" }],
      });

      // Confirm data loaded
      expect(useComposeEditorStore.getState().method).toBe("DELETE");
      expect(useComposeEditorStore.getState().bodyType).toBe("raw");

      useComposeEditorStore.getState().reset();

      const state = useComposeEditorStore.getState();
      expect(state.method).toBe("GET");
      expect(state.url).toBe("");
      expect(state.headers).toEqual([]);
      expect(state.body).toBe("");
      expect(state.bodyType).toBe("none");
      expect(state.rawLanguage).toBe("json");
      expect(state.formDataEntries).toEqual([]);
      expect(state.urlEncodedEntries).toEqual([]);
      expect(state.activeTab).toBe("headers");
    });
  });

  // --- Setters ---

  describe("setters", () => {
    it("setActiveTab", () => {
      useComposeEditorStore.getState().setActiveTab("body");
      expect(useComposeEditorStore.getState().activeTab).toBe("body");
    });

    it("setMethod", () => {
      useComposeEditorStore.getState().setMethod("PUT");
      expect(useComposeEditorStore.getState().method).toBe("PUT");
    });

    it("setBodyType", () => {
      useComposeEditorStore.getState().setBodyType("formdata");
      expect(useComposeEditorStore.getState().bodyType).toBe("formdata");
    });
  });
});
