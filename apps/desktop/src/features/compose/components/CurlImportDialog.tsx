import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";

import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { inferRawLanguageFromContentType, parseCurlCommand } from "@/features/compose/curl-import";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

export function CurlImportDialog(props: { onClose: () => void; open: boolean }) {
  const { t } = useI18n();
  const { onClose, open } = props;
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleImport() {
    const parsed = parseCurlCommand(command);
    if (!parsed) {
      setError(t("composePage.importCurlInvalid"));
      return;
    }
    setError(null);

    const store = useComposeEditorStore.getState();
    const contentType = parsed.headers.find(
      (header) => header.name.toLowerCase() === "content-type",
    )?.value;
    const urlEncodedEntries =
      parsed.bodyType === "urlencoded"
        ? Array.from(new URLSearchParams(parsed.body ?? "").entries()).map(([name, value]) => ({
            name,
            value,
          }))
        : [];
    // Imported file references are display-only: they have no backend-issued
    // token, so they must not enter the send-capable file list.
    if (parsed.formFiles.length > 0) {
      setError(t("composePage.formFile.importRequiresReattach"));
      return;
    }
    store.loadFromSession({
      bodyType: parsed.bodyType,
      body: parsed.body ?? "",
      formDataEntries: parsed.formDataEntries,
      formFiles: [],
      headers: parsed.headers,
      method: parsed.method,
      rawLanguage:
        parsed.bodyType === "raw" && contentType
          ? inferRawLanguageFromContentType(contentType)
          : "json",
      url: parsed.url,
      urlEncodedEntries,
    });
    onClose();
  }

  return (
    <Dialog fullWidth maxWidth="md" open={open} onClose={onClose}>
      <DialogTitle>{t("composePage.importCurlTitle")}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <TextField
            autoFocus
            fullWidth
            minRows={8}
            multiline
            onChange={(e) => {
              setCommand(e.target.value);
              setError(null);
            }}
            placeholder={t("composePage.importCurlPlaceholder")}
            size="small"
            sx={{ "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 } }}
            value={command}
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
        <Button disabled={!command.trim()} variant="contained" onClick={handleImport}>
          {t("composePage.importCurlAction")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
