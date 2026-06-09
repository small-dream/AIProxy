import LinkRoundedIcon from "@mui/icons-material/LinkRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  InputAdornment,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  TextField,
  Tooltip,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { alpha } from "@mui/material/styles";
import type { PointerEvent as ReactPointerEvent } from "react";

import { ComposeRequestSection } from "@/features/compose/components/ComposeRequestSection";
import {
  ComposeResponseSection,
  type ComposeResponseTab,
} from "@/features/compose/components/ComposeResponseSection";
import type { CollectionEditorState } from "@/features/collections/collection-editor.store";
import { HTTP_METHODS } from "@/features/collections/collections-layout.helpers";
import { EmptyWorkspace } from "@/features/collections/components/PaneStates";
import { WorkbenchPane } from "@/features/collections/components/WorkbenchPane";
import { appFontCssVars } from "@/themes/fonts";
import type { TranslationKey, TranslationParams } from "@/i18n";
import type { SessionDetail } from "@aiproxy/shared-types";

export interface CollectionEditorPaneProps {
  // Editor state
  editor: CollectionEditorState;
  requestTab: "headers" | "body" | "query";
  responseTab: ComposeResponseTab;
  requestCollapsed: boolean;
  inspectorSplitRatio: number;
  sendPending: boolean;
  sendError: boolean;
  sendErrorMessage: string | undefined;
  responseDetail: SessionDetail | undefined;
  upsertPending: boolean;
  hasEnvError: boolean;

  // Selected state
  collectionSelected: boolean;
  collectionId: string | null;

  // Callbacks
  onSend: () => void;
  onSave: () => void;
  onCreateRequest: () => void;
  onRequestTabChange: (tab: "headers" | "body" | "query") => void;
  onResponseTabChange: (tab: ComposeResponseTab) => void;
  onRequestCollapsedChange: (collapsed: boolean) => void;
  onInspectorResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;

  // i18n
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

export function CollectionEditorPane({
  editor,
  requestTab,
  responseTab,
  requestCollapsed,
  inspectorSplitRatio,
  sendPending,
  sendError,
  sendErrorMessage,
  responseDetail,
  upsertPending,
  hasEnvError,
  collectionSelected,
  collectionId,
  onSend,
  onSave,
  onCreateRequest,
  onRequestTabChange,
  onResponseTabChange,
  onRequestCollapsedChange,
  onInspectorResizeStart,
  t,
}: CollectionEditorPaneProps) {
  if (!collectionId) {
    return (
      <WorkbenchPane
        sx={{
          borderBottomLeftRadius: 0,
          borderTopLeftRadius: 0,
          minWidth: 0,
        }}
      >
        <EmptyWorkspace
          collectionSelected={collectionSelected}
          onCreateRequest={onCreateRequest}
          t={t}
        />
      </WorkbenchPane>
    );
  }

  return (
    <WorkbenchPane
      sx={{
        borderBottomLeftRadius: 0,
        borderTopLeftRadius: 0,
        minWidth: 0,
      }}
    >
      <Stack sx={{ flex: 1, minHeight: 0 }}>
        <Box
          sx={(theme) => ({
            bgcolor: alpha(
              theme.palette.background.paper,
              theme.palette.mode === "dark" ? 0.74 : 0.86,
            ),
            borderBottom: 1,
            borderColor: "divider",
            flexShrink: 0,
            p: 1,
          })}
        >
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
            <Select
              size="small"
              sx={{
                flex: "0 0 112px",
                fontFamily: appFontCssVars.content,
                fontSize: 13,
                fontWeight: 800,
                "& .MuiSelect-select": {
                  alignItems: "center",
                  display: "flex",
                  py: 0.9,
                },
              }}
              value={editor.method}
              onChange={(e) => editor.setMethod(e.target.value)}
            >
              {HTTP_METHODS.map((method) => (
                <MenuItem
                  key={method}
                  sx={{ fontFamily: appFontCssVars.content, fontSize: 13, fontWeight: 700 }}
                  value={method}
                >
                  {method}
                </MenuItem>
              ))}
            </Select>
            <OutlinedInput
              fullWidth
              placeholder={t("composePage.urlPlaceholder")}
              size="small"
              startAdornment={
                <InputAdornment position="start">
                  <LinkRoundedIcon sx={{ color: "text.secondary", fontSize: 18 }} />
                </InputAdornment>
              }
              sx={(theme: Theme) => ({
                bgcolor: alpha(
                  theme.palette.background.default,
                  theme.palette.mode === "dark" ? 0.38 : 0.62,
                ),
                fontFamily: appFontCssVars.content,
                fontSize: 13,
                minWidth: 0,
                "& .MuiOutlinedInput-input": {
                  py: 1,
                },
              })}
              value={editor.url}
              onChange={(e) => editor.setUrl(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter" && editor.url.trim() && !hasEnvError) onSend();
              }}
            />
            <Tooltip title={t("collectionsPage.saveRequest")}>
              <span>
                <Button
                  disabled={upsertPending}
                  onClick={onSave}
                  size="small"
                  sx={{ flex: "0 0 auto", minHeight: 36, minWidth: 104 }}
                  variant="outlined"
                >
                  {editor.itemId
                    ? t("collectionsPage.updateRequest")
                    : t("collectionsPage.saveAsNew")}
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={t("collectionsPage.sendRequest")}>
              <span>
                <Button
                  disabled={!editor.url.trim() || sendPending || hasEnvError}
                  onClick={onSend}
                  size="small"
                  startIcon={sendPending ? undefined : <SendRoundedIcon />}
                  sx={{ flex: "0 0 auto", minHeight: 36, minWidth: 88 }}
                  variant="contained"
                >
                  {sendPending ? (
                    <CircularProgress color="inherit" size={18} />
                  ) : (
                    t("collectionsPage.sendRequest")
                  )}
                </Button>
              </span>
            </Tooltip>
          </Stack>

          <Stack
            direction="row"
            spacing={0.75}
            sx={{ alignItems: "center", mt: 0.75, minWidth: 0 }}
          >
            <TextField
              placeholder={t("collectionsPage.requestName")}
              size="small"
              value={editor.name}
              onChange={(e) => editor.setName(e.target.value)}
              sx={{
                flex: "0 1 280px",
                minWidth: 180,
                "& .MuiInputBase-input": {
                  fontSize: 13,
                  fontWeight: 700,
                  py: 0.75,
                },
              }}
            />
            <TextField
              placeholder={t("collectionsPage.descriptionPlaceholder")}
              size="small"
              value={editor.description}
              onChange={(e) => editor.setDescription(e.target.value)}
              sx={{
                flex: "1 1 240px",
                minWidth: 0,
                "& .MuiInputBase-input": {
                  color: "text.secondary",
                  fontSize: 12.5,
                  py: 0.75,
                },
              }}
            />
          </Stack>
        </Box>

        <Box
          sx={{
            display: "grid",
            flex: "1 1 0",
            gridTemplateRows: requestCollapsed
              ? "auto 1px minmax(0, 1fr)"
              : `${inspectorSplitRatio}fr 1px ${1 - inspectorSplitRatio}fr`,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <ComposeRequestSection
            activeTab={requestTab}
            body={editor.body}
            bodyType={editor.bodyType}
            chromeless
            formDataEntries={editor.formDataEntries}
            headers={editor.headers}
            onActiveTabChange={onRequestTabChange}
            onBodyChange={editor.setBody}
            onBodyTypeChange={editor.setBodyType}
            onFormDataEntriesChange={editor.setFormDataEntries}
            onHeadersChange={editor.setHeaders}
            onRequestCollapsedChange={onRequestCollapsedChange}
            onRawLanguageChange={editor.setRawLanguage}
            onUrlChange={editor.setUrl}
            onUrlEncodedEntriesChange={editor.setUrlEncodedEntries}
            rawLanguage={editor.rawLanguage}
            requestCollapsed={requestCollapsed}
            url={editor.url}
            urlEncodedEntries={editor.urlEncodedEntries}
          />

          {requestCollapsed ? (
            <Divider />
          ) : (
            <Box
              aria-hidden
              onPointerDown={onInspectorResizeStart}
              sx={{
                alignItems: "center",
                cursor: "row-resize",
                display: "flex",
                justifyContent: "center",
                minHeight: 0,
                position: "relative",
                touchAction: "none",
                userSelect: "none",
                "&::before": {
                  bgcolor: (theme) =>
                    alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.76 : 1),
                  content: '""',
                  height: 1,
                  opacity: 1,
                  transition: "background-color 120ms ease, opacity 120ms ease",
                  width: "100%",
                },
                "&::after": {
                  content: '""',
                  inset: "-3px 0",
                  position: "absolute",
                },
                "&:hover::before": {
                  bgcolor: "primary.main",
                  opacity: 1,
                },
              }}
            />
          )}

          <ComposeResponseSection
            chromeless
            errorMessage={sendErrorMessage}
            isError={sendError}
            isPending={sendPending}
            onResponseTabChange={onResponseTabChange}
            responseDetail={responseDetail}
            responseTab={responseTab}
          />
        </Box>
      </Stack>
    </WorkbenchPane>
  );
}
