import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  useDeleteEnvironment,
  useEnvironmentVariables,
  useEnvironments,
  useGlobalVariables,
  useSetEnvironmentVariables,
  useSetGlobalVariables,
  useUpsertEnvironment,
} from "@/features/environments/use-environments";
import {
  VariableEditorTable,
  type VariableRow,
} from "@/features/environments/components/VariableEditorTable";
import { useEnvVarsSaveManager } from "@/features/environments/use-env-vars-save-manager";
import { useI18n } from "@/i18n";

type TabValue = "environments" | "globals";

export function EnvironmentManagerDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<TabValue>("environments");
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [newEnvName, setNewEnvName] = useState("");
  const [isAddingEnv, setIsAddingEnv] = useState(false);

  const environmentsQuery = useEnvironments();
  const upsertEnv = useUpsertEnvironment();
  const deleteEnv = useDeleteEnvironment();
  const envVarsQuery = useEnvironmentVariables(selectedEnvId);
  const setEnvVars = useSetEnvironmentVariables();

  const globalVarsQuery = useGlobalVariables();
  const setGlobalVars = useSetGlobalVariables();

  const [localEnvVars, setLocalEnvVars] = useState<VariableRow[]>([]);
  const [localGlobalVars, setLocalGlobalVars] = useState<VariableRow[]>([]);
  // M28: in-app confirmation state for environment deletion. Replaces the
  // native `window.confirm`, which rendered a browser-style dialog with
  // buttons that ignored the app's i18n locale and MUI styling.
  const [confirmDeleteEnv, setConfirmDeleteEnv] = useState<
    { id: string; name: string } | null
  >(null);

  const globalSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M24: keep a ref to the latest local global vars so the unmount cleanup can
  // flush a pending debounced save with the most recent edits (not a stale
  // closure value captured when the timeout was scheduled).
  const localGlobalVarsRef = useRef<VariableRow[]>(localGlobalVars);
  useEffect(() => {
    localGlobalVarsRef.current = localGlobalVars;
  }, [localGlobalVars]);
  // M24: hold the latest `setGlobalVars.mutate` in a ref. The whole mutation
  // result object (`setGlobalVars`) is NOT a stable reference — React Query
  // returns a fresh object every render (carrying isPending etc.) — so a
  // `useCallback`/`useEffect` depending on it would re-run on every render.
  // `mutate` itself is stable, so we capture it once per render into the ref
  // and let the unmount cleanup depend only on a stable `flushRef`-thunk.
  const mutateGlobalVarsRef = useRef(setGlobalVars.mutate);
  useEffect(() => {
    mutateGlobalVarsRef.current = setGlobalVars.mutate;
  });

  // Depend on query .data directly (stable reference from the query cache, or
  // undefined when disabled/failed) — avoids a new `[]` identity on every render.
  useEffect(() => {
    if (envVarsQuery.data) {
      setLocalEnvVars(
        envVarsQuery.data.map((v) => ({
          id: v.id,
          key: v.key,
          value: v.value,
          enabled: v.enabled,
          sortOrder: v.sortOrder,
        })),
      );
    }
  }, [envVarsQuery.data]);

  useEffect(() => {
    if (globalVarsQuery.data) {
      setLocalGlobalVars(
        globalVarsQuery.data.map((v) => ({
          id: v.id,
          key: v.key,
          value: v.value,
          enabled: v.enabled,
          sortOrder: v.sortOrder,
        })),
      );
    }
  }, [globalVarsQuery.data]);

  // Env-var saves are debounced AND must flush on env switch so the previous
  // env's pending edit is not silently dropped by the new env's first edit
  // (H8). The unmount "ghost save" cleanup (M9) is handled inside the hook.
  const { scheduleSave: scheduleEnvVarsSave } = useEnvVarsSaveManager({
    selectedEnvId,
    save: (input) =>
      setEnvVars.mutate({
        environmentId: input.environmentId,
        variables: input.variables,
      }),
  });

  // Flush the pending global-vars debounced save immediately. M24: closing the
  // dialog within the 500ms debounce window previously just cleared the timer,
  // silently dropping the in-flight edit. Now we run the save with the latest
  // local value before clearing.
  //
  // This callback has NO dependencies (it reads everything via refs), so its
  // identity is stable for the lifetime of the component — the unmount cleanup
  // below registers once instead of re-running on every render (which the
  // previous `[..., setGlobalVars]` deps caused, since the whole mutation
  // result object changes identity each render).
  const flushGlobalVars = useCallback(() => {
    if (!globalSaveTimeoutRef.current) return;
    clearTimeout(globalSaveTimeoutRef.current);
    globalSaveTimeoutRef.current = null;
    const variables = localGlobalVarsRef.current;
    mutateGlobalVarsRef.current(
      variables.map((v, i) => ({
        id: v.id,
        key: v.key,
        value: v.value,
        enabled: v.enabled,
        sortOrder: i,
      })),
    );
  }, []);

  // M24: on unmount, flush any pending global-vars debounced save instead of
  // just clearing the timer. Global vars are not env-scoped so they do not
  // need the H8 flush-on-switch behavior, but they DO need to be persisted
  // when the dialog closes mid-debounce. The empty dep array registers the
  // cleanup exactly once (on unmount), not on every render.
  useEffect(() => {
    return () => {
      flushGlobalVars();
    };
  }, [flushGlobalVars]);

  const debouncedSaveGlobalVars = useCallback(
    (variables: VariableRow[]) => {
      if (globalSaveTimeoutRef.current) clearTimeout(globalSaveTimeoutRef.current);
      globalSaveTimeoutRef.current = setTimeout(() => {
        globalSaveTimeoutRef.current = null;
        mutateGlobalVarsRef.current(
          variables.map((v, i) => ({
            id: v.id,
            key: v.key,
            value: v.value,
            enabled: v.enabled,
            sortOrder: i,
          })),
        );
      }, 500);
    },
    [],
  );

  function handleCreateEnvironment() {
    const name = newEnvName.trim();
    if (!name) return;
    upsertEnv.mutate(
      { name },
      {
        onSuccess: (env) => {
          setNewEnvName("");
          setIsAddingEnv(false);
          setSelectedEnvId(env.id);
        },
      },
    );
  }

  // M28: open an in-app confirmation dialog instead of the native
  // `window.confirm`, which rendered a browser-style dialog that ignored the
  // app's i18n locale and MUI styling. The actual deletion runs in
  // `confirmDeleteEnvironment` once the user confirms.
  function handleDeleteEnvironment(envId: string, envName: string) {
    setConfirmDeleteEnv({ id: envId, name: envName });
  }

  function confirmDeleteEnvironment() {
    const target = confirmDeleteEnv;
    setConfirmDeleteEnv(null);
    if (!target) return;
    deleteEnv.mutate(target.id, {
      onSuccess: () => {
        if (selectedEnvId === target.id) {
          setSelectedEnvId(null);
          setLocalEnvVars([]);
        }
      },
    });
  }


  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>{t("collectionsPage.manageEnvironments")}</DialogTitle>
      <DialogContent sx={{ pt: 0, minHeight: 480 }}>
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)} sx={{ mb: 2 }}>
          <Tab value="environments" label={t("collectionsPage.environmentSelector")} />
          <Tab value="globals" label={t("collectionsPage.globalVariables")} />
        </Tabs>

        {activeTab === "environments" && (
          <Stack direction="row" spacing={2} sx={{ height: 420 }}>
            {/* Environment list */}
            <Box
              sx={{
                width: 200,
                minWidth: 200,
                borderRight: 1,
                borderColor: "divider",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {environmentsQuery.isError && (
                <Alert severity="error" sx={{ m: 1, py: 0.5 }}>
                  {t("common.errors.generic")}
                </Alert>
              )}
              <Typography variant="caption" sx={{ fontWeight: 600, mb: 1, px: 0.5 }}>
                {t("collectionsPage.environmentSelector")}
              </Typography>
              <Box sx={{ flex: 1, overflow: "auto" }}>
                {(environmentsQuery.data ?? []).map((env) => (
                  <Stack
                    key={env.id}
                    direction="row"
                    onClick={() => setSelectedEnvId(env.id)}
                    sx={{
                      px: 1,
                      py: 0.75,
                      cursor: "pointer",
                      borderRadius: 1,
                      bgcolor: selectedEnvId === env.id ? "action.selected" : "transparent",
                      "&:hover": { bgcolor: "action.hover" },
                      alignItems: "center",
                      gap: 0.5,
                    }}
                  >
                    <Typography
                      variant="caption"
                      sx={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: selectedEnvId === env.id ? 600 : 400,
                      }}
                    >
                      {env.name}
                    </Typography>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteEnvironment(env.id, env.name);
                      }}
                      sx={{
                        opacity: 0,
                        ".MuiStack-root:hover &": { opacity: 1 },
                        color: "text.secondary",
                      }}
                    >
                      <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Stack>
                ))}
                {(environmentsQuery.data ?? []).length === 0 &&
                  !environmentsQuery.isError && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        p: 1,
                        display: "block"
                      }}>
                      {t("common.empty.noData")}
                    </Typography>
                  )}
              </Box>
              <Box sx={{ pt: 1, borderTop: 1, borderColor: "divider" }}>
                {isAddingEnv ? (
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                    <TextField
                      autoFocus
                      size="small"
                      placeholder={t("collectionsPage.environmentName")}
                      value={newEnvName}
                      onChange={(e) => setNewEnvName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreateEnvironment();
                        if (e.key === "Escape") {
                          setIsAddingEnv(false);
                          setNewEnvName("");
                        }
                      }}
                      sx={{ flex: 1, "& input": { fontSize: 13 } }}
                    />
                    <Button
                      size="small"
                      variant="contained"
                      disabled={!newEnvName.trim() || upsertEnv.isPending}
                      onClick={handleCreateEnvironment}
                    >
                      {t("common.actions.add")}
                    </Button>
                  </Stack>
                ) : (
                  <Button
                    startIcon={<AddRoundedIcon sx={{ fontSize: 18 }} />}
                    onClick={() => setIsAddingEnv(true)}
                    size="small"
                    variant="text"
                    sx={{ minHeight: 30, px: 1.25 }}
                  >
                    {t("collectionsPage.newEnvironment")}
                  </Button>
                )}
              </Box>
            </Box>

            {/* Variable editor */}
            <Box sx={{ flex: 1, overflow: "auto" }}>
              {envVarsQuery.isError ? (
                <Box
                  sx={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    p: 2,
                  }}
                >
                  <Alert severity="error" sx={{ width: "100%" }}>
                    {t("common.errors.generic")}
                  </Alert>
                </Box>
              ) : selectedEnvId ? (
                <VariableEditorTable
                  key={selectedEnvId}
                  keyPlaceholder={t("collectionsPage.variableKey")}
                  onChange={(vars) => {
                    setLocalEnvVars(vars);
                    scheduleEnvVarsSave(vars);
                  }}
                  valuePlaceholder={t("collectionsPage.variableValue")}
                  variables={localEnvVars}
                />
              ) : (
                <Box
                  sx={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    {t("common.empty.noData")}
                  </Typography>
                </Box>
              )}
            </Box>
          </Stack>
        )}

        {activeTab === "globals" && (
          <Box sx={{ height: 420, overflow: "auto" }}>
            {globalVarsQuery.isError ? (
              <Box
                sx={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  p: 2,
                }}
              >
                <Alert severity="error" sx={{ width: "100%" }}>
                  {t("common.errors.generic")}
                </Alert>
              </Box>
            ) : (
              <VariableEditorTable
                keyPlaceholder={t("collectionsPage.variableKey")}
                onChange={(vars) => {
                  setLocalGlobalVars(vars);
                  debouncedSaveGlobalVars(vars);
                }}
                valuePlaceholder={t("collectionsPage.variableValue")}
                variables={localGlobalVars}
              />
            )}
          </Box>
        )}
      </DialogContent>

      {/* M28: in-app confirmation dialog for environment deletion. Replaces the
           native window.confirm which ignored the app's i18n locale and MUI
           styling. Mirrors the AppShellDialogs confirm pattern. */}
      <Dialog
        fullWidth
        maxWidth="xs"
        onClose={() => setConfirmDeleteEnv(null)}
        open={confirmDeleteEnv !== null}
      >
        <DialogTitle>{t("collectionsPage.deleteEnvironmentTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {confirmDeleteEnv
              ? t("collectionsPage.deleteEnvironmentConfirm", {
                  name: confirmDeleteEnv.name,
                })
              : ""}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmDeleteEnv(null)}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            color="error"
            onClick={confirmDeleteEnvironment}
            variant="contained"
          >
            {t("common.actions.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
