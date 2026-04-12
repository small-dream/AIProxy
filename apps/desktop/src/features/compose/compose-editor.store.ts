import { create } from "zustand";
import type { HeaderEntry } from "@pharles/shared-types";

type ComposeEditorState = {
  method: string;
  url: string;
  headers: HeaderEntry[];
  body: string;
  activeTab: "headers" | "body" | "query";
  setMethod: (method: string) => void;
  setUrl: (url: string) => void;
  setHeaders: (headers: HeaderEntry[]) => void;
  setBody: (body: string) => void;
  setActiveTab: (tab: "headers" | "body" | "query") => void;
  loadFromSession: (data: {
    method: string;
    url: string;
    headers: HeaderEntry[];
    body?: string;
  }) => void;
  reset: () => void;
};

const INITIAL_STATE = {
  method: "GET",
  url: "",
  headers: [] as HeaderEntry[],
  body: "",
  activeTab: "headers" as const,
};

export const useComposeEditorStore = create<ComposeEditorState>((set) => ({
  ...INITIAL_STATE,
  setMethod: (method) => set({ method }),
  setUrl: (url) => set({ url }),
  setHeaders: (headers) => set({ headers }),
  setBody: (body) => set({ body }),
  setActiveTab: (activeTab) => set({ activeTab }),
  loadFromSession: (data) =>
    set({
      method: data.method,
      url: data.url,
      headers: [...data.headers],
      body: data.body ?? "",
      activeTab: "headers",
    }),
  reset: () => set(INITIAL_STATE),
}));
