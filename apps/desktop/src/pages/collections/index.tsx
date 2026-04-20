import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CreateNewFolderRoundedIcon from "@mui/icons-material/CreateNewFolderRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useState } from "react";

import type { HeaderEntry } from "@aiproxy/shared-types";

import { buildMultipartBody, FORMDATA_CONTENT_TYPE, RAW_LANGUAGE_CONTENT_TYPE, URLENCODED_CONTENT_TYPE } from "@/features/compose/compose-editor.store";
import { ComposeRequestSection } from "@/features/compose/components/ComposeRequestSection";
import { ComposeResponseSection, type ComposeResponseTab } from "@/features/compose/components/ComposeResponseSection";
import { useCollectionEditorStore } from "@/features/collections/collection-editor.store";
import {
  useCollectionItems,
  useUpsertCollectionItem,
  useDeleteCollectionItem,
} from "@/features/collections/use-collection-items";
import {
  useCollections,
  useUpsertCollection,
  useDeleteCollection,
  buildCollectionTree,
  type CollectionTreeNode,
} from "@/features/collections/use-collections";
import { useEnvironments, useEnvironmentVariables } from "@/features/environments/use-environments";
import { substituteVariables } from "@/features/environments/use-environments";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { useI18n } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { appFontCssVars } from "@/themes/fonts";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const METHOD_COLORS: Record<string, string> = {
  GET: "#4caf50",
  POST: "#ff9800",
  PUT: "#2196f3",
  PATCH: "#9c27b0",
  DELETE: "#f44336",
  HEAD: "#607d8b",
  OPTIONS: "#795548",
};

function ensureContentType(
  headers: HeaderEntry[],
  contentType: string,
): HeaderEntry[] {
  if (headers.some((h) => h.name.toLowerCase() === "content-type")) return headers;
  return [...headers, { name: "Content-Type", value: contentType }];
}

export function CollectionsPage() {
  const { t } = useI18n();

  // Collections tree
  const collectionsQuery = useCollections();
  const upsertCollection = useUpsertCollection();
  const deleteCollectionMutation = useDeleteCollection();
  const tree = buildCollectionTree(collectionsQuery.data ?? []);

  // Selection state
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // Collection items
  const itemsQuery = useCollectionItems(selectedCollectionId);

  // Editor store
  const editor = useCollectionEditorStore();

  // Send request
  const sendMutation = useSendComposedRequest();

  // Environments
  const environmentsQuery = useEnvironments();
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(null);
  const envVarsQuery = useEnvironmentVariables(activeEnvironmentId);

  // Upsert/delete items
  const upsertItemMutation = useUpsertCollectionItem();
  const deleteItemMutation = useDeleteCollectionItem();

  // Dialog state
  const [newCollectionDialogOpen, setNewCollectionDialogOpen] = useState(false);
  const [newCollectionParentId, setNewCollectionParentId] = useState<string | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");

  // Response display state
  const [requestTab, setRequestTab] = useState<"headers" | "body" | "query">("headers");
  const [responseTab, setResponseTab] = useState<ComposeResponseTab>("overview");
  const [searchValue, setSearchValue] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  // When selecting an item, load it into the editor
  function handleSelectItem(item: { id: string; collectionId: string; name: string; description: string; method: string; url: string; headers: HeaderEntry[]; body: string; bodyType: string; rawLanguage: string; formData: HeaderEntry[]; urlEncoded: HeaderEntry[] }) {
    setSelectedItemId(item.id);
    setRequestTab("headers");
    editor.loadFromItem(item);
  }

  // Send with variable substitution
  function handleSend() {
    const vars = envVarsQuery.data ?? [];

    const substitutedUrl = substituteVariables(editor.url, vars);
    const substitutedBody = substituteVariables(editor.body, vars);

    let finalHeaders = editor.headers.map((h) => ({
      name: h.name,
      value: substituteVariables(h.value, vars),
    }));

    let encodedBody: string | undefined;
    switch (editor.bodyType) {
      case "formdata": {
        const active = editor.formDataEntries.filter((e) => e.name.trim());
        if (active.length > 0) {
          const boundary = `----AIProxyBoundary${Date.now().toString(16)}`;
          encodedBody = buildMultipartBody(active, boundary);
          finalHeaders = ensureContentType(finalHeaders, `${FORMDATA_CONTENT_TYPE}; boundary=${boundary}`);
        }
        break;
      }
      case "urlencoded": {
        const active = editor.urlEncodedEntries.filter((e) => e.name.trim());
        if (active.length > 0) {
          encodedBody = active
            .map((e) => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`)
            .join("&");
          finalHeaders = ensureContentType(finalHeaders, URLENCODED_CONTENT_TYPE);
        }
        break;
      }
      case "raw": {
        if (substitutedBody.trim()) {
          encodedBody = substitutedBody;
          finalHeaders = ensureContentType(finalHeaders, RAW_LANGUAGE_CONTENT_TYPE[editor.rawLanguage]);
        }
        break;
      }
    }

    sendMutation.mutate({
      workspaceId: "default",
      method: editor.method,
      url: substitutedUrl,
      headers: finalHeaders,
      ...(encodedBody ? { body: encodedBody } : {}),
    });
  }

  // Save current editor state to collection item
  function handleSave() {
    if (!editor.collectionId) return;
    upsertItemMutation.mutate({
      ...(editor.itemId ? { id: editor.itemId } : {}),
      collectionId: editor.collectionId,
      name: editor.name || `${editor.method} ${editor.url}`,
      description: editor.description,
      method: editor.method,
      url: editor.url,
      headers: editor.headers,
      body: editor.body,
      bodyType: editor.bodyType,
      rawLanguage: editor.rawLanguage,
      formData: editor.formDataEntries,
      urlEncoded: editor.urlEncodedEntries,
    });
  }

  // Create new collection / folder
  function handleCreateCollection() {
    if (!newCollectionName.trim()) return;
    upsertCollection.mutate(
      {
        parentId: newCollectionParentId,
        name: newCollectionName.trim(),
      },
      {
        onSuccess: () => {
          setNewCollectionDialogOpen(false);
          setNewCollectionName("");
        },
      },
    );
  }

  const responseDetail = sendMutation.data;

  return (
    <Stack direction="row" sx={{ height: "100%", minHeight: 0 }}>
      {/* Left: Collection Tree */}
      <Box
        sx={{
          width: 220,
          minWidth: 220,
          borderRight: 1,
          borderColor: "divider",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <Stack direction="row" sx={{ p: 1, gap: 0.5, alignItems: "center" }}>
          <Typography variant="caption" sx={{ flex: 1, fontWeight: 600, pl: 1 }}>
            {t("collectionsPage.title")}
          </Typography>
          <Tooltip title={t("collectionsPage.newFolder")}>
            <IconButton
              size="small"
              onClick={() => {
                setNewCollectionParentId(null);
                setNewCollectionDialogOpen(true);
              }}
            >
              <CreateNewFolderRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Divider />
        <Box sx={{ flex: 1, overflow: "auto", py: 0.5 }}>
          {tree.map((node) => (
            <CollectionTreeNodeView
              key={node.id}
              node={node}
              selectedCollectionId={selectedCollectionId}
              onSelect={setSelectedCollectionId}
              onDelete={deleteCollectionMutation.mutate}
              onAddChild={(parentId) => {
                setNewCollectionParentId(parentId);
                setNewCollectionDialogOpen(true);
              }}
              depth={0}
              t={t}
            />
          ))}
          {tree.length === 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ p: 2 }}>
              {t("collectionsPage.emptyCollections")}
            </Typography>
          )}
        </Box>

        {/* Environment selector */}
        <Divider />
        <Box sx={{ p: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: "block" }}>
            {t("collectionsPage.environmentSelector")}
          </Typography>
          <Select
            size="small"
            fullWidth
            value={activeEnvironmentId ?? ""}
            onChange={(e) => setActiveEnvironmentId(e.target.value || null)}
            sx={{ fontSize: 12 }}
          >
            <MenuItem value="">
              <em>{t("collectionsPage.noEnvironment")}</em>
            </MenuItem>
            {(environmentsQuery.data ?? []).map((env) => (
              <MenuItem key={env.id} value={env.id}>
                {env.name}
              </MenuItem>
            ))}
          </Select>
        </Box>
      </Box>

      {/* Middle: Item List */}
      <Box
        sx={{
          width: 260,
          minWidth: 260,
          borderRight: 1,
          borderColor: "divider",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <Stack direction="row" sx={{ p: 1, gap: 0.5, alignItems: "center" }}>
          <Typography variant="caption" sx={{ flex: 1, fontWeight: 600, pl: 1 }}>
            {selectedCollectionId ? t("collectionsPage.title") : ""}
          </Typography>
          {selectedCollectionId && (
            <Tooltip title={t("collectionsPage.saveRequest")}>
              <IconButton
                size="small"
                onClick={() => {
                  editor.reset();
                  setRequestTab("headers");
                  setSelectedItemId(null);
                  if (selectedCollectionId) {
                    useCollectionEditorStore.setState({ collectionId: selectedCollectionId });
                  }
                }}
              >
                <AddRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
        <Divider />
        <Box sx={{ flex: 1, overflow: "auto" }}>
          {(itemsQuery.data ?? []).map((item) => (
            <ItemRow
              key={item.id}
              method={item.method}
              name={item.name}
              selected={item.id === selectedItemId}
              onClick={() => handleSelectItem(item)}
              onDelete={() => {
                if (selectedCollectionId) {
                  deleteItemMutation.mutate({ id: item.id, collectionId: selectedCollectionId });
                  if (selectedItemId === item.id) {
                    setSelectedItemId(null);
                    editor.reset();
                  }
                }
              }}
            />
          ))}
          {selectedCollectionId && (itemsQuery.data ?? []).length === 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ p: 2 }}>
              {t("collectionsPage.emptyCollection")}
            </Typography>
          )}
        </Box>
      </Box>

      {/* Right: Editor */}
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {editor.collectionId ? (
          <>
            {/* Editor toolbar */}
            <Stack direction="row" spacing={1} sx={{ p: 1, alignItems: "center" }}>
              <TextField
                size="small"
                placeholder={t("collectionsPage.requestName")}
                value={editor.name}
                onChange={(e) => editor.setName(e.target.value)}
                sx={{ flex: 1, "& input": { fontSize: 13 } }}
              />
              <Tooltip title={t("collectionsPage.saveRequest")}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={upsertItemMutation.isPending}
                    onClick={handleSave}
                  >
                    {editor.itemId ? t("collectionsPage.updateRequest") : t("collectionsPage.saveAsNew")}
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={t("collectionsPage.sendRequest")}>
                <span>
                  <IconButton
                    color="primary"
                    disabled={!editor.url.trim() || sendMutation.isPending}
                    onClick={handleSend}
                    size="small"
                  >
                    {sendMutation.isPending ? (
                      <CircularProgress size={20} color="inherit" />
                    ) : (
                      <SendRoundedIcon />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>

            {/* URL Bar */}
            <Stack direction="row" spacing={1} sx={{ px: 1, pb: 1, alignItems: "center" }}>
              <Select
                size="small"
                sx={{ flex: "0 0 110px", fontFamily: appFontCssVars.content, fontSize: 13, fontWeight: 600 }}
                value={editor.method}
                onChange={(e) => editor.setMethod(e.target.value)}
              >
                {HTTP_METHODS.map((m) => (
                  <MenuItem key={m} sx={{ fontFamily: appFontCssVars.content, fontSize: 13 }} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
              <OutlinedInput
                fullWidth
                placeholder="https://api.example.com/endpoint"
                size="small"
                sx={{ fontFamily: appFontCssVars.content, fontSize: 13 }}
                value={editor.url}
                onChange={(e) => editor.setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && editor.url.trim()) handleSend();
                }}
              />
            </Stack>
            <Divider />

            {/* Request/Response split */}
            <Box sx={{ flex: 1, overflow: "auto" }}>
              <Box sx={{ height: "50%", overflow: "auto" }}>
                <ComposeRequestSection
                  activeTab={requestTab}
                  body={editor.body}
                  bodyType={editor.bodyType}
                  formDataEntries={editor.formDataEntries}
                  headers={editor.headers}
                  onActiveTabChange={setRequestTab}
                  onBodyChange={editor.setBody}
                  onBodyTypeChange={editor.setBodyType}
                  onFormDataEntriesChange={editor.setFormDataEntries}
                  onHeadersChange={editor.setHeaders}
                  onRawLanguageChange={editor.setRawLanguage}
                  onUrlChange={editor.setUrl}
                  onUrlEncodedEntriesChange={editor.setUrlEncodedEntries}
                  rawLanguage={editor.rawLanguage}
                  url={editor.url}
                  urlEncodedEntries={editor.urlEncodedEntries}
                />
              </Box>
              <Divider />
              <Box sx={{ height: "50%", overflow: "auto" }}>
                <ComposeResponseSection
                  errorMessage={sendMutation.error?.message}
                  isError={sendMutation.isError}
                  isPending={sendMutation.isPending}
                  onCopyResponse={() => {
                    void navigator.clipboard.writeText(
                      responseDetail?.responseBody?.inlineText ?? "",
                    );
                  }}
                  onResponseTabChange={setResponseTab}
                  onSearchOpenChange={setSearchOpen}
                  onSearchValueChange={setSearchValue}
                  responseDetail={responseDetail}
                  responseTab={responseTab}
                  searchOpen={searchOpen}
                  searchValue={searchValue}
                />
              </Box>
            </Box>
          </>
        ) : (
          <Box
            sx={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Typography color="text.secondary">
              {t("collectionsPage.noItemSelected")}
            </Typography>
          </Box>
        )}
      </Box>

      {/* New Collection Dialog */}
      <Dialog
        open={newCollectionDialogOpen}
        onClose={() => setNewCollectionDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          {newCollectionParentId ? t("collectionsPage.newFolder") : t("collectionsPage.newCollection")}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label={t("collectionsPage.namePlaceholder")}
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateCollection();
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewCollectionDialogOpen(false)}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="contained"
            disabled={!newCollectionName.trim()}
            onClick={handleCreateCollection}
          >
            {t("common.actions.add")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

// --- Sub-components ---

function CollectionTreeNodeView({
  node,
  selectedCollectionId,
  onSelect,
  onDelete,
  onAddChild,
  depth,
  t,
}: {
  node: CollectionTreeNode;
  selectedCollectionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  depth: number;
  t: (key: TranslationKey) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const selected = node.id === selectedCollectionId;
  const pl = 1 + depth * 2;

  return (
    <Box>
      <Stack
        direction="row"
        onClick={() => {
          onSelect(node.id);
          setExpanded(true);
        }}
        sx={{
          px: 1,
          pl,
          py: 0.5,
          cursor: "pointer",
          bgcolor: selected ? "action.selected" : "transparent",
          "&:hover": { bgcolor: "action.hover" },
          alignItems: "center",
          gap: 0.5,
        }}
      >
        <Typography
          variant="caption"
          sx={{
            flex: 1,
            fontWeight: node.parentId ? 400 : 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.name}
        </Typography>
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            onAddChild(node.id);
          }}
          sx={{ opacity: 0, ".MuiStack-root:hover &": { opacity: 1 } }}
        >
          <AddRoundedIcon sx={{ fontSize: 14 }} />
        </IconButton>
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(node.id);
          }}
          sx={{ opacity: 0, ".MuiStack-root:hover &": { opacity: 1 } }}
        >
          <DeleteRoundedIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Stack>
      {expanded &&
        node.children.map((child) => (
          <CollectionTreeNodeView
            key={child.id}
            node={child}
            selectedCollectionId={selectedCollectionId}
            onSelect={onSelect}
            onDelete={onDelete}
            onAddChild={onAddChild}
            depth={depth + 1}
            t={t}
          />
        ))}
    </Box>
  );
}

function ItemRow({
  method,
  name,
  selected,
  onClick,
  onDelete,
}: {
  method: string;
  name: string;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <Stack
      direction="row"
      onClick={onClick}
      sx={{
        px: 1.5,
        py: 0.75,
        cursor: "pointer",
        bgcolor: selected ? "action.selected" : "transparent",
        "&:hover": { bgcolor: "action.hover" },
        alignItems: "center",
        gap: 1,
      }}
    >
      <Typography
        variant="caption"
        sx={{
          fontWeight: 700,
          color: METHOD_COLORS[method] ?? "text.secondary",
          minWidth: 36,
          fontSize: 11,
        }}
      >
        {method}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </Typography>
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        sx={{ opacity: 0, ".MuiStack-root:hover &": { opacity: 1 } }}
      >
        <DeleteRoundedIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Stack>
  );
}
