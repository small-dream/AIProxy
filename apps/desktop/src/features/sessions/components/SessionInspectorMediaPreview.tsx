import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import SaveAltRoundedIcon from "@mui/icons-material/SaveAltRounded";
import { Alert, Box, Divider, ListItemIcon, ListItemText, Menu, MenuItem, Snackbar, Stack, Typography } from "@mui/material";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BodyReference, SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "@/i18n";
import { guessExtension } from "@/features/sessions/session-ui.helpers";
import { buildContextMenuSlotProps, contextMenuItemTextProps, getContextMenuDividerSx, getContextMenuIconSx, getContextMenuItemSx } from "./context-menu.styles";
import { InspectorScrollArea } from "./SessionInspectorShared";

type PreviewProps = {
  detail: SessionDetail | undefined;
  isLoading: boolean;
  session: SessionSummary;
};

type MediaKind = "audio" | "image" | "unsupported" | "video";

function getMediaKind(mimeType?: string): MediaKind {
  if (!mimeType) return "unsupported";
  const lower = mimeType.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("audio/")) return "audio";
  if (lower.startsWith("video/")) return "video";
  return "unsupported";
}

function buildDataUri(body: BodyReference): string | null {
  const mimeType = body.mimeType;
  if (!mimeType) return null;

  if (body.inlineText !== undefined && mimeType.toLowerCase().includes("svg")) {
    return `data:image/svg+xml,${encodeURIComponent(body.inlineText)}`;
  }

  if (body.base64Text !== undefined) {
    return `data:${mimeType};base64,${body.base64Text}`;
  }

  return null;
}

export const SessionInspectorMediaPreview = function SessionInspectorMediaPreview({
  detail,
  isLoading,
  session,
}: PreviewProps) {
  const { t } = useI18n();
  const body = detail?.responseBody;
  const mimeType = body?.mimeType;
  const mediaKind = getMediaKind(mimeType);
  const isDeferred = body?.base64Deferred && body.base64Text === undefined;
  const isSvgWithoutText = mimeType?.toLowerCase().includes("svg") && body?.inlineText === undefined && body?.base64Text === undefined;

  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ anchorPosition: { left: number; top: number } } | null>(null);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");

  const dataUri = useMemo(() => (body ? buildDataUri(body) : null), [body]);

  useEffect(() => {
    setImageDimensions(null);
    setLoadError(false);
  }, [dataUri]);

  const handleImageLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    }
    setLoadError(false);
  }, []);

  const handleMediaError = useCallback(() => {
    setLoadError(true);
  }, []);

  const showSnackbar = useCallback((message: string) => {
    setSnackbarMessage(message);
    setSnackbarOpen(true);
  }, []);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    if (!dataUri) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ anchorPosition: { left: event.clientX - 2, top: event.clientY - 4 } });
  }, [dataUri]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleCopyImage = useCallback(async () => {
    closeContextMenu();
    if (!dataUri) return;
    try {
      const response = await fetch(dataUri);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      showSnackbar(t("contextMenu.copiedToClipboard"));
    } catch {
      showSnackbar(t("inspector.response.preview.loadFailed"));
    }
  }, [closeContextMenu, dataUri, showSnackbar, t]);

  const handleSaveAs = useCallback(async () => {
    closeContextMenu();
    if (!body) return;

    const ext = guessExtension(mimeType ?? "");
    const nameFromPath = session.path.split("/").pop() ?? "media";
    const defaultName = `${nameFromPath}.${ext}`;

    const selected = await save({
      defaultPath: defaultName,
      filters: [{
        extensions: [ext],
        name: mimeType ?? "*",
      }],
    });

    if (!selected) return;

    try {
      let base64Content = body.base64Text;
      if (!base64Content && body.inlineText) {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(body.inlineText);
        base64Content = btoa(String.fromCharCode(...bytes));
      }
      if (!base64Content) return;

      await invoke("save_media_file", {
        input: { base64Content, path: String(selected) },
      });
    } catch {
      showSnackbar(t("inspector.response.preview.loadFailed"));
    }
  }, [body, closeContextMenu, mimeType, session.path, showSnackbar, t]);

  const handleCopyUrl = useCallback(async () => {
    closeContextMenu();
    await navigator.clipboard.writeText(session.url);
    showSnackbar(t("contextMenu.copiedToClipboard"));
  }, [closeContextMenu, session.url, showSnackbar, t]);

  const handleOpenInBrowser = useCallback(async () => {
    closeContextMenu();
    await openUrl(session.url);
  }, [closeContextMenu, session.url]);

  if (!body) {
    return (
      <InspectorScrollArea>
        <Alert severity="info">{t("inspector.response.preview.noMediaBody")}</Alert>
      </InspectorScrollArea>
    );
  }

  if (mediaKind === "unsupported") {
    return (
      <InspectorScrollArea>
        <Alert severity="info">{t("inspector.response.preview.unsupportedFormat")}</Alert>
      </InspectorScrollArea>
    );
  }

  if ((isLoading && isDeferred) || isSvgWithoutText) {
    return (
      <InspectorScrollArea>
        <Typography color="text.secondary" variant="body2">
          {t("inspector.response.preview.loading")}
        </Typography>
      </InspectorScrollArea>
    );
  }

  if (loadError) {
    return (
      <InspectorScrollArea>
        <Alert severity="warning">{t("inspector.response.preview.loadFailed")}</Alert>
      </InspectorScrollArea>
    );
  }

  if (!dataUri) {
    return (
      <InspectorScrollArea>
        <Alert severity="info">{t("inspector.response.preview.noMediaBody")}</Alert>
      </InspectorScrollArea>
    );
  }

  const isImage = mediaKind === "image";

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
      <Box onContextMenu={handleContextMenu} sx={{ flex: 1, minHeight: 0, overflow: "auto", textAlign: "center" }}>
        {mediaKind === "image" && (
          <Box
            component="img"
            alt=""
            onError={handleMediaError}
            onLoad={handleImageLoad}
            src={dataUri}
            sx={{
              display: "block",
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              margin: "0 auto",
            }}
          />
        )}

        {mediaKind === "audio" && (
          <Box sx={{ p: 2 }}>
            <audio controls onError={handleMediaError} src={dataUri} style={{ width: "100%" }}>
              <Typography color="text.secondary" variant="body2">
                {t("inspector.response.preview.unsupportedFormat")}
              </Typography>
            </audio>
          </Box>
        )}

        {mediaKind === "video" && (
          <Box
            component="video"
            controls
            onError={handleMediaError}
            src={dataUri}
            sx={{
              display: "block",
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              margin: "0 auto",
            }}
          >
            <Typography color="text.secondary" variant="body2">
              {t("inspector.response.preview.unsupportedFormat")}
            </Typography>
          </Box>
        )}
      </Box>

      <Stack direction="row" spacing={2} sx={{ px: 1, pb: 0.5 }}>
        {imageDimensions && (
          <Typography color="text.secondary" variant="caption">
            {t("inspector.response.preview.dimensions")}: {imageDimensions.width} x {imageDimensions.height}
          </Typography>
        )}
        {body.sizeBytes > 0 && (
          <Typography color="text.secondary" variant="caption">
            {body.sizeBytes} bytes
          </Typography>
        )}
        {body.truncated && (
          <Typography color="warning.main" variant="caption">
            Truncated
          </Typography>
        )}
      </Stack>

      <Menu
        anchorPosition={contextMenu?.anchorPosition ?? { left: 0, top: 0 }}
        anchorReference="anchorPosition"
        onClose={closeContextMenu}
        open={Boolean(contextMenu)}
        slotProps={buildContextMenuSlotProps(200)}
        sx={(theme) => ({ "& .MuiMenuItem-root": getContextMenuItemSx(theme) })}
      >
        {isImage && (
          <MenuItem onClick={() => { void handleCopyImage(); }}>
            <ListItemIcon sx={(theme) => getContextMenuIconSx(theme)}>
              <ContentCopyRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText {...contextMenuItemTextProps} primary={t("inspector.response.preview.contextMenu.copyImage")} />
          </MenuItem>
        )}
        <MenuItem onClick={() => { void handleSaveAs(); }}>
          <ListItemIcon sx={(theme) => getContextMenuIconSx(theme)}>
            <SaveAltRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps} primary={isImage ? t("inspector.response.preview.contextMenu.saveImageAs") : t("inspector.response.preview.contextMenu.saveAs")} />
        </MenuItem>
        <Divider sx={(theme) => getContextMenuDividerSx(theme)} />
        <MenuItem onClick={() => { void handleCopyUrl(); }}>
          <ListItemIcon sx={(theme) => getContextMenuIconSx(theme)}>
            <ContentCopyRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps} primary={isImage ? t("inspector.response.preview.contextMenu.copyImageUrl") : t("inspector.response.preview.contextMenu.copyUrl")} />
        </MenuItem>
        <MenuItem onClick={() => { void handleOpenInBrowser(); }}>
          <ListItemIcon sx={(theme) => getContextMenuIconSx(theme)}>
            <OpenInNewRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps} primary={t("inspector.response.preview.contextMenu.openInBrowser")} />
        </MenuItem>
      </Menu>

      <Snackbar
        autoHideDuration={1800}
        message={snackbarMessage}
        onClose={() => setSnackbarOpen(false)}
        open={snackbarOpen}
      />
    </Stack>
  );
};
