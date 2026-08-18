import { coerceAppError, type SessionSummary } from "@aiproxy/shared-types";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";

import { useI18n } from "@/i18n";
import { getSaveableSessions } from "@/features/sessions/session-save-files.helpers";
import {
  type ResponseFileConflictStrategy,
  type SaveResponseFilesResult,
  saveResponseFiles,
} from "@/services/commands";

export type SaveResponseFilesTarget = {
  /** Folder label shown to the user — a host or a URL path segment. */
  label: string;
  /** Every session under the folder, including nested subfolders. */
  sessions: SessionSummary[];
};

type SaveResponseFilesDialogProps = {
  onClose: () => void;
  onCompleted: (result: SaveResponseFilesResult) => void;
  open: boolean;
  target: SaveResponseFilesTarget | null;
};

/**
 * Charles-style "save every captured file under this folder". The destination
 * directory is chosen by the backend's own picker once the user confirms, so
 * this dialog only collects the conflict strategy.
 */
export function SaveResponseFilesDialog({
  onClose,
  onCompleted,
  open,
  target,
}: SaveResponseFilesDialogProps) {
  const { t } = useI18n();
  const [conflictStrategy, setConflictStrategy] =
    useState<ResponseFileConflictStrategy>("latestOnly");
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();

  useEffect(() => {
    if (!open) {
      return;
    }

    setConflictStrategy("latestOnly");
    setErrorMessage(undefined);
  }, [open]);

  const saveableSessions = useMemo(() => getSaveableSessions(target?.sessions ?? []), [target]);

  async function handleSave() {
    if (saveableSessions.length === 0) {
      return;
    }

    setErrorMessage(undefined);
    setIsSaving(true);

    try {
      const result = await saveResponseFiles({
        sessionIds: saveableSessions.map((session) => session.id),
        conflictStrategy,
        title: t("sessionsSaveFiles.pickerTitle"),
      });

      // `null` means the user dismissed the directory picker; keep the dialog
      // open so their strategy choice is not lost.
      if (!result) {
        return;
      }

      onCompleted(result);
      onClose();
    } catch (error) {
      // Command wrappers throw plain `AppError` objects (never `Error`
      // instances), so the real message has to come through `coerceAppError` —
      // e.g. the backend's "Cannot save more than 20000 files at once."
      setErrorMessage(coerceAppError(error).message.trim() || t("common.errors.generic"));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={onClose}>
      <DialogTitle>{t("sessionsSaveFiles.title")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <Alert severity="info" variant="outlined">
            {t("sessionsSaveFiles.summary", {
              count: saveableSessions.length,
              label: target?.label ?? "",
            })}
          </Alert>

          <Stack spacing={1}>
            <Typography variant="subtitle2">{t("sessionsSaveFiles.conflictTitle")}</Typography>
            <RadioGroup
              onChange={(event) =>
                setConflictStrategy(event.target.value as ResponseFileConflictStrategy)
              }
              value={conflictStrategy}
            >
              <FormControlLabel
                control={<Radio size="small" />}
                label={
                  <Stack>
                    <Typography variant="body2">
                      {t("sessionsSaveFiles.conflict.latestOnly")}
                    </Typography>
                    <Typography color="text.secondary" variant="caption">
                      {t("sessionsSaveFiles.conflict.latestOnlyDescription")}
                    </Typography>
                  </Stack>
                }
                value="latestOnly"
              />
              <FormControlLabel
                control={<Radio size="small" />}
                label={
                  <Stack>
                    <Typography variant="body2">
                      {t("sessionsSaveFiles.conflict.keepAll")}
                    </Typography>
                    <Typography color="text.secondary" variant="caption">
                      {t("sessionsSaveFiles.conflict.keepAllDescription")}
                    </Typography>
                  </Stack>
                }
                value="keepAll"
              />
            </RadioGroup>
          </Stack>

          <Typography color="text.secondary" variant="caption">
            {t("sessionsSaveFiles.layoutHint")}
          </Typography>

          {errorMessage ? (
            <Alert severity="error" variant="outlined">
              {errorMessage}
            </Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
        <Button
          disabled={saveableSessions.length === 0 || isSaving}
          onClick={handleSave}
          variant="contained"
        >
          {t("sessionsSaveFiles.chooseDirectory")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
