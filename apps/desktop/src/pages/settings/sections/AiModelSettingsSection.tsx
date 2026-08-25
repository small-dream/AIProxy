import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import { Alert, Button, MenuItem, Select, TextField } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { coerceAppError, type SaveAiSettingsInput } from "@aiproxy/shared-types";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";
import { getAiSettings, saveAiSettings, testAiConnection } from "@/services/commands";
import {
  compactAlertSx,
  selectControlSx,
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
} from "../SettingsLayoutParts";

const AI_SETTINGS_QUERY_KEY = ["ai-settings"];
const AI_DEFAULT_TEMPERATURE = 0.2;
const AI_DEFAULT_TIMEOUT_MS = 60_000;

export function AiModelSettingsSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: AI_SETTINGS_QUERY_KEY,
    queryFn: getAiSettings,
  });
  const saveMutation = useMutation({
    mutationFn: (input: SaveAiSettingsInput) => saveAiSettings(input),
    onSuccess: (nextSettings) => {
      queryClient.setQueryData(AI_SETTINGS_QUERY_KEY, nextSettings);
      setApiKeyDraft(nextSettings.maskedApiKey ?? "");
      setApiKeyDraftDirty(false);
      setFeedback({ severity: "success", message: t("settingsPage.aiSaveSuccess") });
    },
    onError: (error) => {
      setFeedback({
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    },
    // Failures render in the local feedback banner; skip the global toast.
    meta: { suppressGlobalErrorNotification: true },
  });
  const testMutation = useMutation({
    mutationFn: testAiConnection,
    onSuccess: (result) => {
      setFeedback({
        severity: result.ok ? "success" : "error",
        message: result.message,
      });
    },
    onError: (error) => {
      setFeedback({
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    },
    // Failures render in the local feedback banner; skip the global toast.
    meta: { suppressGlobalErrorNotification: true },
  });
  const [draft, setDraft] = useState<SaveAiSettingsInput>({
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    temperature: AI_DEFAULT_TEMPERATURE,
    timeoutMs: AI_DEFAULT_TIMEOUT_MS,
  });
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyDraftDirty, setApiKeyDraftDirty] = useState(false);
  const [feedback, setFeedback] = useState<{
    severity: "error" | "info" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!settings) {
      return;
    }

    setDraft({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: settings.temperature,
      timeoutMs: settings.timeoutMs,
    });
    setApiKeyDraft(settings.maskedApiKey ?? "");
    setApiKeyDraftDirty(false);
  }, [settings]);

  function handleSave(clearApiKey = false) {
    saveMutation.mutate({
      ...draft,
      apiKey: apiKeyDraftDirty ? apiKeyDraft : undefined,
      clearApiKey,
    });
  }

  const modelError = draft.model.trim().length === 0;
  const baseUrlError = draft.baseUrl.trim().length === 0;
  const busy = saveMutation.isPending || testMutation.isPending;

  return (
    <SectionCard
      compact
      title={t("settingsPage.aiSectionTitle")}
      description={t("settingsPage.aiSectionDescription")}
    >
      <SettingsGroup>
        <SettingsRow label={t("settingsPage.aiProvider")}>
          <Select
            size="small"
            value={draft.provider}
            onChange={(event) =>
              setDraft({
                ...draft,
                provider: event.target.value as SaveAiSettingsInput["provider"],
              })
            }
            inputProps={{ "aria-label": t("settingsPage.aiProvider") }}
            sx={selectControlSx}
          >
            <MenuItem value="openai-compatible">OpenAI-compatible</MenuItem>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("settingsPage.aiBaseUrl")}>
          <TextField
            size="small"
            hiddenLabel
            value={draft.baseUrl}
            error={baseUrlError}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            slotProps={{ htmlInput: { "aria-label": t("settingsPage.aiBaseUrl") } }}
            sx={selectControlSx}
          />
        </SettingsRow>

        <SettingsRow label={t("settingsPage.aiModel")}>
          <TextField
            size="small"
            hiddenLabel
            value={draft.model}
            error={modelError}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            slotProps={{ htmlInput: { "aria-label": t("settingsPage.aiModel") } }}
            sx={selectControlSx}
          />
        </SettingsRow>

        <SettingsRow label={t("settingsPage.aiApiKey")}>
          <TextField
            size="small"
            hiddenLabel
            placeholder={t("settingsPage.aiApiKeyPlaceholder")}
            type={apiKeyDraftDirty ? "password" : "text"}
            value={apiKeyDraft}
            onFocus={() => {
              if (!apiKeyDraftDirty && settings?.hasApiKey) {
                setApiKeyDraft("");
              }
            }}
            onBlur={() => {
              if (!apiKeyDraftDirty && settings?.maskedApiKey) {
                setApiKeyDraft(settings.maskedApiKey);
              }
            }}
            onChange={(event) => {
              setApiKeyDraft(event.target.value);
              setApiKeyDraftDirty(true);
            }}
            slotProps={{ htmlInput: { "aria-label": t("settingsPage.aiApiKey") } }}
            sx={selectControlSx}
          />
        </SettingsRow>

        <SettingsFooter>
          <Button
            size="small"
            variant="outlined"
            disabled={busy || !settings?.hasApiKey}
            onClick={() => handleSave(true)}
            sx={{ minHeight: 34 }}
          >
            {t("settingsPage.aiClearKey")}
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={busy || !settings?.hasApiKey}
            onClick={() => testMutation.mutate()}
            sx={{ minHeight: 34 }}
          >
            {testMutation.isPending ? t("settingsPage.aiTesting") : t("settingsPage.aiTest")}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<SaveRoundedIcon />}
            disabled={busy || modelError || baseUrlError}
            onClick={() => handleSave(false)}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {saveMutation.isPending ? t("proxyPresets.saving") : t("proxyPresets.save")}
          </Button>
        </SettingsFooter>
      </SettingsGroup>

      {feedback ? (
        <Alert severity={feedback.severity} variant="outlined" sx={{ ...compactAlertSx, mt: 1 }}>
          {feedback.message}
        </Alert>
      ) : null}
    </SectionCard>
  );
}
