import { create } from "zustand";
import type { HeaderEntry } from "@aiproxy/shared-types";

type BodyType = "none" | "formdata" | "urlencoded" | "raw";
type RawLanguage = "text" | "json" | "xml" | "html" | "javascript";

type CollectionEditorState = {
  // Item identity
  itemId: string | null;
  collectionId: string | null;
  name: string;
  description: string;

  // Request fields (mirror compose-editor.store)
  method: string;
  url: string;
  headers: HeaderEntry[];
  body: string;
  bodyType: BodyType;
  rawLanguage: RawLanguage;
  formDataEntries: HeaderEntry[];
  urlEncodedEntries: HeaderEntry[];

  // Actions
  loadFromItem: (item: {
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
  }) => void;
  setName: (name: string) => void;
  setDescription: (desc: string) => void;
  setMethod: (method: string) => void;
  setUrl: (url: string) => void;
  setHeaders: (headers: HeaderEntry[]) => void;
  setBody: (body: string) => void;
  setBodyType: (bt: BodyType) => void;
  setRawLanguage: (lang: RawLanguage) => void;
  setFormDataEntries: (entries: HeaderEntry[]) => void;
  setUrlEncodedEntries: (entries: HeaderEntry[]) => void;
  reset: () => void;
};

const INITIAL: Omit<CollectionEditorState, "loadFromItem" | "setName" | "setDescription" | "setMethod" | "setUrl" | "setHeaders" | "setBody" | "setBodyType" | "setRawLanguage" | "setFormDataEntries" | "setUrlEncodedEntries" | "reset"> = {
  itemId: null,
  collectionId: null,
  name: "",
  description: "",
  method: "GET",
  url: "",
  headers: [],
  body: "",
  bodyType: "none" as BodyType,
  rawLanguage: "json" as RawLanguage,
  formDataEntries: [],
  urlEncodedEntries: [],
};

export const useCollectionEditorStore = create<CollectionEditorState>((set) => ({
  ...INITIAL,
  loadFromItem: (item) =>
    set({
      itemId: item.id,
      collectionId: item.collectionId,
      name: item.name,
      description: item.description,
      method: item.method,
      url: item.url,
      headers: [...item.headers],
      body: item.body,
      bodyType: (item.bodyType || "none") as BodyType,
      rawLanguage: (item.rawLanguage || "json") as RawLanguage,
      formDataEntries: [...item.formData],
      urlEncodedEntries: [...item.urlEncoded],
    }),
  setName: (name) => set({ name }),
  setDescription: (description) => set({ description }),
  setMethod: (method) => set({ method }),
  setUrl: (url) => set({ url }),
  setHeaders: (headers) => set({ headers }),
  setBody: (body) => set({ body }),
  setBodyType: (bodyType) => set({ bodyType }),
  setRawLanguage: (rawLanguage) => set({ rawLanguage }),
  setFormDataEntries: (formDataEntries) => set({ formDataEntries }),
  setUrlEncodedEntries: (urlEncodedEntries) => set({ urlEncodedEntries }),
  reset: () => set(INITIAL),
}));
