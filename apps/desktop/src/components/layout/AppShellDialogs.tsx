import { DEFAULT_PROXY_PORT } from "@aiproxy/shared-types";
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  OutlinedInput,
  Stack,
  Typography,
} from "@mui/material";

import { useI18n } from "@/i18n";

type WorkspaceOption = {
  id: string;
  name: string;
  proxyPort: number;
};

type AppShellDialogsProps = {
  isBusy: boolean;
  isRunning: boolean;
  loadWorkspacePending: boolean;
  onClosePortDialog: () => void;
  onCloseWorkspaceDialog: () => void;
  onPortApply: () => void;
  onPortDraftChange: (value: string) => void;
  onWorkspaceSwitch: (workspaceId: string) => void;
  portDialogError: string | null;
  portDialogOpen: boolean;
  portDraft: string;
  workspaceDialogError: string | null;
  workspaceDialogOpen: boolean;
  workspaceId: string;
  workspaces: WorkspaceOption[];
};

export function AppShellDialogs({
  isBusy,
  isRunning,
  loadWorkspacePending,
  onClosePortDialog,
  onCloseWorkspaceDialog,
  onPortApply,
  onPortDraftChange,
  onWorkspaceSwitch,
  portDialogError,
  portDialogOpen,
  portDraft,
  workspaceDialogError,
  workspaceDialogOpen,
  workspaceId,
  workspaces,
}: AppShellDialogsProps) {
  const { t } = useI18n();

  return (
    <>
      <Dialog fullWidth maxWidth="xs" onClose={onCloseWorkspaceDialog} open={workspaceDialogOpen}>
        <DialogTitle>{t("appShell.switchPresetTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 0.5 }}>
            <Typography color="text.secondary" variant="body2">
              {t("appShell.switchPresetRestartHint")}
            </Typography>
            {workspaceDialogError ? (
              <Typography color="error" variant="caption">
                {workspaceDialogError}
              </Typography>
            ) : null}
            <List disablePadding>
              {workspaces.map((workspace) => {
                const isActive = workspace.id === workspaceId;

                return (
                  <ListItemButton
                    key={workspace.id}
                    selected={isActive}
                    disabled={isActive || loadWorkspacePending}
                    onClick={() => void onWorkspaceSwitch(workspace.id)}
                    sx={{ borderRadius: 2, mb: 0.5 }}
                  >
                    <ListItemText
                      primary={workspace.name}
                      secondary={`:${workspace.proxyPort}`}
                      primaryTypographyProps={{ fontWeight: isActive ? 600 : 400 }}
                    />
                    {isActive && (
                      <Chip size="small" label={t("proxyPresets.active")} color="success" />
                    )}
                  </ListItemButton>
                );
              })}
            </List>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onCloseWorkspaceDialog}>{t("common.actions.cancel")}</Button>
        </DialogActions>
      </Dialog>

      <Dialog fullWidth maxWidth="xs" onClose={onClosePortDialog} open={portDialogOpen}>
        <Stack
          component="form"
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            void onPortApply();
          }}
        >
          <DialogTitle>{t("appShell.changePortTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <Typography color="text.secondary" variant="body2">
                {isRunning
                  ? t("appShell.portChangesRestartImmediately")
                  : t("appShell.portChangesStartOnNewPort")}
              </Typography>
              <OutlinedInput
                autoFocus
                error={Boolean(portDialogError)}
                inputProps={{ inputMode: "numeric", max: 65535, min: 1, pattern: "[0-9]*" }}
                onChange={(event) => onPortDraftChange(event.target.value)}
                placeholder={String(DEFAULT_PROXY_PORT)}
                value={portDraft}
              />
              {portDialogError ? (
                <Typography color="error" variant="caption">
                  {portDialogError}
                </Typography>
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={onClosePortDialog}>{t("common.actions.cancel")}</Button>
            <Button disabled={isBusy} type="submit" variant="contained">
              {isRunning ? t("common.actions.applyAndRestart") : t("common.actions.startOnNewPort")}
            </Button>
          </DialogActions>
        </Stack>
      </Dialog>
    </>
  );
}
