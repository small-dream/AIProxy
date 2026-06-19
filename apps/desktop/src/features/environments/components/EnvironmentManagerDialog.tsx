import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import {
  Alert,
  Box,
  Button,
  Dialog,
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

  const envSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const globalSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const debouncedSaveEnvVars = useCallback(
    (variables: VariableRow[]) => {
      if (envSaveTimeoutRef.current) clearTimeout(envSaveTimeoutRef.current);
      envSaveTimeoutRef.current = setTimeout(() => {
        if (selectedEnvId) {
          setEnvVars.mutate({
            environmentId: selectedEnvId,
            variables: variables.map((v, i) => ({
              id: v.id,
              key: v.key,
              value: v.value,
              enabled: v.enabled,
              sortOrder: i,
            })),
          });
        }
      }, 500);
    },
    [selectedEnvId, setEnvVars],
  );

  const debouncedSaveGlobalVars = useCallback(
    (variables: VariableRow[]) => {
      if (globalSaveTimeoutRef.current) clearTimeout(globalSaveTimeoutRef.current);
      globalSaveTimeoutRef.current = setTimeout(() => {
        setGlobalVars.mutate(
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
    [setGlobalVars],
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

  function handleDeleteEnvironment(envId: string, envName: string) {
    if (window.confirm(t("collectionsPage.deleteEnvironmentConfirm", { name: envName }))) {
      deleteEnv.mutate(envId, {
        onSuccess: () => {
          if (selectedEnvId === envId) {
            setSelectedEnvId(null);
            setLocalEnvVars([]);
          }
        },
      });
    }
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
                    debouncedSaveEnvVars(vars);
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
    </Dialog>
  );
}
