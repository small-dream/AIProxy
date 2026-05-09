import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import type { SessionDetail } from "@aiproxy/shared-types";
import { useMemo } from "react";

import { SessionInspectorResponsePane } from "@/features/sessions/components/SessionInspectorResponsePane";
import {
  formatJsonText,
  getBodyText,
  parseJsonBody,
  type JsonParseResult,
  type ResponseInspectorTab,
} from "@/features/sessions/components/session-inspector.helpers";
import { useI18n } from "@/i18n";

export type ComposeResponseTab = ResponseInspectorTab;

type ComposeResponseSectionProps = {
  errorMessage: string | undefined;
  isError: boolean;
  isPending: boolean;
  onResponseTabChange: (tab: ComposeResponseTab) => void;
  responseDetail: SessionDetail | undefined;
  responseTab: ComposeResponseTab;
};

export function ComposeResponseSection({
  errorMessage,
  isError,
  isPending,
  onResponseTabChange,
  responseDetail,
  responseTab,
}: ComposeResponseSectionProps) {
  const { t } = useI18n();
  const responseBodyText = getBodyText(responseDetail?.responseBody);

  const responseJsonResult = useMemo<JsonParseResult>(() => {
    return parseJsonBody(responseDetail?.responseBody, responseBodyText, {
      responseErrorMessage: t("inspector.jsonParse.responseError"),
      tooLargeMessage: t("inspector.jsonParse.tooLarge"),
    });
  }, [responseBodyText, responseDetail?.responseBody, t]);

  const responseJsonDisplayText = useMemo(() => {
    if (responseJsonResult.status !== "success") {
      return undefined;
    }

    return formatJsonText(responseJsonResult.value);
  }, [responseJsonResult]);

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {isPending ? (
        <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ flex: 1 }}>
          <CircularProgress size={32} />
          <Typography color="text.secondary" variant="body2">
            {t("composePage.sendingRequest")}
          </Typography>
        </Stack>
      ) : isError ? (
        <Box sx={{ p: 2 }}>
          <Alert severity="error" variant="outlined">
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{t("composePage.requestFailed")}</Typography>
            <Typography variant="body2">{errorMessage || t("common.errors.unexpected")}</Typography>
          </Alert>
        </Box>
      ) : responseDetail ? (
        <SessionInspectorResponsePane
          detail={responseDetail}
          isResponseBodyLoading={false}
          isResponseRawLoading={false}
          onResponseTabChange={onResponseTabChange}
          responseJsonDisplayText={responseJsonDisplayText}
          responseJsonResult={responseJsonResult}
          responseTab={responseTab}
          session={responseDetail.summary}
        />
      ) : (
        <Stack alignItems="center" justifyContent="center" spacing={0.75} sx={{ flex: 1, px: 3, textAlign: "center" }}>
          <Typography sx={{ fontWeight: 600 }} variant="body2">
            {t("composePage.responsePreviewTitle")}
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {t("composePage.configureHint")}
          </Typography>
        </Stack>
      )}
    </Box>
  );
}
