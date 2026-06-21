import { create } from "zustand";
import type { HeaderEntry } from "@aiproxy/shared-types";
import type { BodyType, RawLanguage } from "./types";
export { type BodyType, type RawLanguage } from "./types";

export const RAW_LANGUAGE_CONTENT_TYPE: Record<RawLanguage, string> = {
  text: "text/plain",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
};

export const URLENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded";
export const FORMDATA_CONTENT_TYPE = "multipart/form-data";

export const RAW_LANGUAGES = [
  { value: "text", labelKey: "composePage.rawLanguages.text" },
  { value: "json", labelKey: "composePage.rawLanguages.json" },
  { value: "xml", labelKey: "composePage.rawLanguages.xml" },
  { value: "html", labelKey: "composePage.rawLanguages.html" },
  { value: "javascript", labelKey: "composePage.rawLanguages.javascript" },
] as const satisfies ReadonlyArray<{ value: RawLanguage; labelKey: string }>;

export function buildMultipartBody(entries: HeaderEntry[], boundary: string): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.name.trim()) continue;
    // Escape structural characters in the field name so a crafted name can't
    // break out of the Content-Disposition header, inject an extra part, or
    // forge the closing boundary (RFC 2388 / M16). Quotes become %22 per the
    // spec; CR/LF are stripped to prevent header/frame injection.
    const safeName = entry.name
      .replace(/"/g, "%22")
      .replace(/[\r\n]/g, "");
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${entry.value}`,
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
    bodyType?: BodyType;
    formDataEntries?: HeaderEntry[];
    method: string;
    rawLanguage?: RawLanguage;
    url: string;
    urlEncodedEntries?: HeaderEntry[];
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
  loadFromSession: (data) => {
    const body = data.body ?? "";
    const bodyType = data.bodyType ?? (body ? "raw" : "none");

    return set({
      method: data.method,
      url: data.url,
      headers: [...data.headers],
      body,
      bodyType,
      rawLanguage: data.rawLanguage ?? "json",
      formDataEntries: data.formDataEntries ? [...data.formDataEntries] : [],
      urlEncodedEntries: data.urlEncodedEntries ? [...data.urlEncodedEntries] : [],
      activeTab: bodyType === "none" ? "headers" : "body",
    });
  },
  reset: () => set(INITIAL_STATE),
}));
