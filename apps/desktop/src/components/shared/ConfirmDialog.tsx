import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
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
  /**
   * Failure of the confirmed action, already reduced to display text. Renders
   * an inline error Alert and keeps the dialog open so the user can retry
   * (P1-23); callers close the dialog themselves on success.
   */
  errorMessage?: string | undefined;
  /**
   * MUI color of the confirm button. Defaults to "error" (destructive
   * deletes); use "warning" for softer discards like unsaved-changes guards.
   */
  confirmColor?: "error" | "warning" | "primary" | "info" | "success";
  /**
   * Optional "don't ask again" opt-out. Only provide for re-capturable data
   * (e.g. Clear All Sessions); irreversible deletes must never offer it.
   * See UI_GUIDELINES §11.4.
   */
  dontAskAgainLabel?: string;
  dontAskAgainChecked?: boolean;
  onDontAskAgainChange?: (checked: boolean) => void;
};

/**
 * Shared confirmation dialog for destructive actions (deletes / clears).
 * Controlled: the caller owns the open state and closes it on success or
 * cancel. Visual pattern mirrors EnvironmentManagerDialog's delete confirm.
 */
export function ConfirmDialog({
  cancelLabel,
  confirmColor = "error",
  confirmLabel,
  dontAskAgainChecked = false,
  dontAskAgainLabel,
  errorMessage,
  isConfirming = false,
  message,
  onCancel,
  onConfirm,
  onDontAskAgainChange,
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
        {errorMessage ? (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {errorMessage}
          </Alert>
        ) : null}
        {dontAskAgainLabel ? (
          <FormControlLabel
            control={
              <Checkbox
                checked={dontAskAgainChecked}
                disabled={isConfirming}
                onChange={(event) => onDontAskAgainChange?.(event.target.checked)}
                size="small"
              />
            }
            label={
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {dontAskAgainLabel}
              </Typography>
            }
            sx={{ mt: 1.5 }}
          />
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button disabled={isConfirming} onClick={onCancel}>
          {cancelLabel ?? t("common.actions.cancel")}
        </Button>
        <Button
          color={confirmColor}
          disabled={isConfirming}
          onClick={onConfirm}
          variant="contained"
        >
          {confirmLabel ?? t("common.actions.delete")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
