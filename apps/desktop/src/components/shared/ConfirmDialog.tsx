import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";

import { useI18n } from "@/i18n";

type ConfirmDialogProps = {
  open: boolean;
  /** Already-translated dialog title. */
  title: string;
  /** Already-translated (and interpolated) confirmation message. */
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Defaults to `common.actions.delete`. */
  confirmLabel?: string;
  /** Defaults to `common.actions.cancel`. */
  cancelLabel?: string;
  /** Drives the confirm button's pending state (e.g. mutation.isPending). */
  isConfirming?: boolean;
};

/**
 * Shared confirmation dialog for destructive actions (deletes / clears).
 * Controlled: the caller owns the open state and closes it on success or
 * cancel. Visual pattern mirrors EnvironmentManagerDialog's delete confirm.
 */
export function ConfirmDialog({
  cancelLabel,
  confirmLabel,
  isConfirming = false,
  message,
  onCancel,
  onConfirm,
  open,
  title,
}: ConfirmDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog fullWidth maxWidth="xs" onClose={onCancel} open={open}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {message}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button disabled={isConfirming} onClick={onCancel}>
          {cancelLabel ?? t("common.actions.cancel")}
        </Button>
        <Button color="error" disabled={isConfirming} onClick={onConfirm} variant="contained">
          {confirmLabel ?? t("common.actions.delete")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
