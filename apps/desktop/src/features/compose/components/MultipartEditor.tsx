import AttachFileRoundedIcon from "@mui/icons-material/AttachFileRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { Box, Button, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { coerceAppError, type FormFileEntry, type HeaderEntry } from "@aiproxy/shared-types";

import { pickAttachmentFile } from "@/services/commands/files";
import { useNotificationStore } from "@/services/notification.store";
import { useI18n } from "@/i18n";

import { EditableKeyValueTable } from "./EditableKeyValueTable";

/**
 * Multipart editor: text fields (via EditableKeyValueTable) on top, attached
 * files below. The renderer stores only file metadata — path + name — and the
 * Rust send path reads the bytes (D1).
 */
export function MultipartEditor(props: {
  entries: HeaderEntry[];
  files: FormFileEntry[];
  onEntriesChange: (entries: HeaderEntry[]) => void;
  onFilesChange: (files: FormFileEntry[]) => void;
}) {
  const { t } = useI18n();
  const { entries, files, onEntriesChange, onFilesChange } = props;

  async function handleAttach() {
    let picked;
    try {
      picked = await pickAttachmentFile(t("composePage.formFile.attachFile"));
    } catch (error) {
      // The Rust picker rejects paths outside the allowed roots at pick time
      // (and requires the desktop runtime); without this handler the failure
      // would be a silent unhandled rejection.
      useNotificationStore
        .getState()
        .push(`${t("composePage.formFile.attachFailed")}: ${coerceAppError(error).message}`);
      return;
    }
    if (!picked) return;
    onFilesChange([
      ...files,
      {
        name: picked.fileName,
        fileName: picked.fileName,
        filePath: picked.filePath,
      },
    ]);
  }

  return (
    <Stack spacing={1}>
      <EditableKeyValueTable
        items={entries}
        namePlaceholder={t("common.placeholders.paramName")}
        onChange={onEntriesChange}
        valuePlaceholder={t("common.placeholders.paramValue")}
      />
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {t("composePage.formFile.hint")}
      </Typography>
      {files.map((file, index) => (
        <Box
          key={`${file.filePath}:${index}`}
          sx={{
            alignItems: "center",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            display: "flex",
            gap: 1,
            px: 1,
            py: 0.75,
          }}
        >
          <AttachFileRoundedIcon sx={{ color: "text.secondary", fontSize: 18 }} />
          <Typography
            noWrap
            variant="body2"
            sx={{ flex: 1, fontSize: 13, minWidth: 0 }}
            title={`${file.name} — ${file.filePath}`}
          >
            {file.name}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
            {file.fileName}
          </Typography>
          <Tooltip title={t("composePage.formFile.removeFile")}>
            <IconButton
              size="small"
              color="error"
              onClick={() => onFilesChange(files.filter((_, fileIndex) => fileIndex !== index))}
            >
              <DeleteOutlineRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      ))}
      <Button
        size="small"
        variant="outlined"
        startIcon={<AttachFileRoundedIcon />}
        onClick={() => void handleAttach()}
        sx={{ alignSelf: "flex-start" }}
      >
        {t("composePage.formFile.attachFile")}
      </Button>
    </Stack>
  );
}
