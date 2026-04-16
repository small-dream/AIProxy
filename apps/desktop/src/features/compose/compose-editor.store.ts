import { create } from "zustand";
import type { HeaderEntry } from "@aiproxy/shared-types";

export type BodyType = "none" | "formdata" | "urlencoded" | "raw";
export type RawLanguage = "text" | "json" | "xml" | "html" | "javascript";

export const RAW_LANGUAGE_CONTENT_TYPE: Record<RawLanguage, string> = {
  text: "text/plain",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
};

export const URLENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded";
export const FORMDATA_CONTENT_TYPE = "multipart/form-data";

export const RAW_LANGUAGES: { value: RawLanguage; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "json", label: "JSON" },
  { value: "xml", label: "XML" },
  { value: "html", label: "HTML" },
  { value: "javascript", label: "JavaScript" },
];

export function buildMultipartBody(entries: HeaderEntry[], boundary: string): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.name.trim()) continue;
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${entry.name}"\r\n\r\n${entry.value}`,
    );
  }
  if (parts.length > 0) {
    parts.push(`\r\n--${boundary}--`);
  }
  return parts.join("\r\n");
}

type ComposeEditorState = {
  method: string;
  url: string;
  headers: HeaderEntry[];
  body: string;
  bodyType: BodyType;
  rawLanguage: RawLanguage;
  formDataEntries: HeaderEntry[];
  urlEncodedEntries: HeaderEntry[];
  activeTab: "headers" | "body" | "query";
  setMethod: (method: string) => void;
  setUrl: (url: string) => void;
  setHeaders: (headers: HeaderEntry[]) => void;
  setBody: (body: string) => void;
  setBodyType: (bodyType: BodyType) => void;
  setRawLanguage: (rawLanguage: RawLanguage) => void;
  setFormDataEntries: (entries: HeaderEntry[]) => void;
  setUrlEncodedEntries: (entries: HeaderEntry[]) => void;
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
  bodyType: "none" as BodyType,
  rawLanguage: "json" as RawLanguage,
  formDataEntries: [] as HeaderEntry[],
  urlEncodedEntries: [] as HeaderEntry[],
  activeTab: "headers" as const,
};

export const useComposeEditorStore = create<ComposeEditorState>((set) => ({
  ...INITIAL_STATE,
  setMethod: (method) => set({ method }),
  setUrl: (url) => set({ url }),
  setHeaders: (headers) => set({ headers }),
  setBody: (body) => set({ body }),
  setBodyType: (bodyType) => set({ bodyType }),
  setRawLanguage: (rawLanguage) => set({ rawLanguage }),
  setFormDataEntries: (formDataEntries) => set({ formDataEntries }),
  setUrlEncodedEntries: (urlEncodedEntries) => set({ urlEncodedEntries }),
  setActiveTab: (activeTab) => set({ activeTab }),
  loadFromSession: (data) =>
    set({
      method: data.method,
      url: data.url,
      headers: [...data.headers],
      body: data.body ?? "",
      bodyType: data.body ? "raw" : "none",
      rawLanguage: "json",
      formDataEntries: [],
      urlEncodedEntries: [],
      activeTab: "headers",
    }),
  reset: () => set(INITIAL_STATE),
}));
