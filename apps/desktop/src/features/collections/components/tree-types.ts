import type { FormFileEntry, HeaderEntry } from "@aiproxy/shared-types";

export type CollectionEditorItem = {
  body: string;
  bodyType: string;
  collectionId: string;
  description: string;
  formData: HeaderEntry[];
  formFiles: FormFileEntry[];
  headers: HeaderEntry[];
  id: string;
  method: string;
  name: string;
  rawLanguage: string;
  url: string;
  urlEncoded: HeaderEntry[];
};

export type RenameTarget =
  | {
      kind: "collection";
      id: string;
      name: string;
      parentId: string | null;
    }
  | {
      kind: "item";
      item: CollectionEditorItem;
    };
