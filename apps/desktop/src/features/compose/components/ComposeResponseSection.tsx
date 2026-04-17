import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Alert, Box, CircularProgress, IconButton, OutlinedInput, Stack, Tab, Tabs, Typography } from "@mui/material";
import type { SessionDetail } from "@aiproxy/shared-types";
import { useMemo } from "react";

import { InspectorDefinitionList, InspectorKeyValueTable, SearchableCodeBlock } from "@/features/sessions/components/SessionInspectorShared";
import { SessionInspectorJsonTree } from "@/features/sessions/components/SessionInspectorJsonTree";
import { formatJsonText, getBodyText, parseJsonBody, type JsonParseResult } from "@/features/sessions/components/session-inspector.helpers";
import { useI18n } from "@/i18n";
import { appFontCssVars } from "@/themes/fonts";

export type ComposeResponseTab = "overview" | "headers" | "json" | "jsonText" | "raw" | "timing";

type ComposeResponseSectionProps = {
  errorMessage: string | undefined;
  isError: boolean;
  isPending: boolean;
  onCopyResponse: () => void;
  onResponseTabChange: (tab: ComposeResponseTab) => void;
  onSearchOpenChange: (open: boolean) => void;
  onSearchValueChange: (value: string) => void;
  responseDetail: SessionDetail | undefined;
  responseTab: ComposeResponseTab;
  searchOpen: boolean;
  searchValue: string;
};

export function ComposeResponseSection({
  errorMessage,
  isError,
  isPending,
  onCopyResponse,
  onResponseTabChange,
  onSearchOpenChange,
  onSearchValueChange,
  responseDetail,
  responseTab,
  searchOpen,
  searchValue,
}: ComposeResponseSectionProps) {
  const { t } = useI18n();
  const responseBodyText = getBodyText(responseDetail?.responseBody);

  const responseJsonResult = useMemo<JsonParseResult>(() => {
    if (responseTab !== "json" && responseTab !== "jsonText") {
      return { status: "idle" };
    }

    return parseJsonBody(responseDetail?.responseBody, responseBodyText, {
      responseErrorMessage: t("inspector.jsonParse.responseError"),
      tooLargeMessage: t("inspector.jsonParse.tooLarge"),
    });
  }, [responseBodyText, responseDetail?.responseBody, responseTab, t]);

  const responseJsonDisplayText = useMemo(() => {
    if (responseTab !== "jsonText" || responseJsonResult.status !== "success") {
      return undefined;
    }

    return formatJsonText(responseJsonResult.value);
  }, [responseJsonResult, responseTab]);

  const showSearch = responseTab === "json" || responseTab === "jsonText";

  const responseTabContent = useMemo(() => {
    if (!responseDetail) {
      return null;
    }

    switch (responseTab) {
      case "overview":
        return (
          <InspectorDefinitionList
            items={[
              [t("common.labels.status"), String(responseDetail.summary.statusCode)],
              [t("common.labels.duration"), t("common.tech.milliseconds", { value: responseDetail.summary.durationMs })],
              [t("common.labels.size"), t("common.tech.bytes", { value: responseDetail.summary.sizeBytes })],
              [t("composePage.responseBody"), responseDetail.responseBody ? t("common.tech.bytes", { value: responseDetail.responseBody.sizeBytes }) : t("common.tech.noBody")],
              [t("composePage.timingTotal"), responseDetail.timing?.totalMs != null ? t("common.tech.milliseconds", { value: responseDetail.timing.totalMs }) : t("common.states.notCaptured")],
            ]}
          />
        );
      case "headers":
        return (
          <InspectorKeyValueTable
            emptyMessage={t("composePage.responseHeadersEmpty")}
            items={responseDetail.responseHeaders.map((header) => [header.name, header.value])}
          />
        );
      case "json":
        if (responseJsonResult.status === "tooLarge") {
          return <Alert severity="info">{responseJsonResult.message}</Alert>;
        }
        if (responseJsonResult.status === "error") {
          return <Alert severity="warning">{responseJsonResult.message}</Alert>;
        }
        if (responseJsonResult.status === "idle") {
          return <Typography color="text.secondary" sx={{ py: 2 }} variant="body2">{t("composePage.responseNoBody")}</Typography>;
        }
        return <SessionInspectorJsonTree searchQuery={searchValue} value={responseJsonResult.value} />;
      case "jsonText":
        if (responseJsonResult.status === "tooLarge") {
          return (
            <Stack spacing={1.5}>
              <Alert severity="info">{responseJsonResult.message}</Alert>
              <SearchableCodeBlock code={responseBodyText ?? ""} language="plain" searchQuery={searchValue} />
            </Stack>
          );
        }
        if (responseJsonResult.status === "error") {
          return <Alert severity="warning">{responseJsonResult.message}</Alert>;
        }
        if (responseJsonResult.status === "success") {
          return <SearchableCodeBlock code={responseJsonDisplayText ?? ""} language="json" searchQuery={searchValue} />;
        }
        return <Typography color="text.secondary" sx={{ py: 2 }} variant="body2">{t("composePage.responseNoBody")}</Typography>;
      case "raw":
        return (
          <SearchableCodeBlock
            code={responseDetail.rawResponse ?? t("composePage.responseNoBody")}
            language="plain"
            searchQuery=""
          />
        );
      case "timing": {
        const timing = responseDetail.timing;

        return (
          <InspectorDefinitionList
            items={[
              [t("composePage.dns"), timing?.dnsMs != null ? t("common.tech.milliseconds", { value: timing.dnsMs }) : t("common.states.notCaptured")],
              [t("composePage.connect"), timing?.connectMs != null ? t("common.tech.milliseconds", { value: timing.connectMs }) : t("common.states.notCaptured")],
              [t("composePage.tls"), timing?.tlsMs != null ? t("common.tech.milliseconds", { value: timing.tlsMs }) : t("common.states.notCaptured")],
              [t("composePage.requestSend"), timing?.requestSendMs != null ? t("common.tech.milliseconds", { value: timing.requestSendMs }) : t("common.states.notCaptured")],
              [t("composePage.waiting"), timing?.waitingMs != null ? t("common.tech.milliseconds", { value: timing.waitingMs }) : t("common.states.notCaptured")],
              [t("composePage.responseRead"), timing?.responseReadMs != null ? t("common.tech.milliseconds", { value: timing.responseReadMs }) : t("common.states.notCaptured")],
              [t("common.labels.total"), timing?.totalMs != null ? t("common.tech.milliseconds", { value: timing.totalMs }) : t("common.states.notCaptured")],
            ]}
          />
        );
      }
    }
  }, [responseDetail, responseJsonDisplayText, responseJsonResult, responseBodyText, responseTab, searchValue, t]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
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
        <>
          <Box sx={{ display: "flex", alignItems: "center", borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
            <Tabs
              onChange={(_, value) => onResponseTabChange(value)}
              sx={{ minHeight: 32, flex: 1 }}
              TabIndicatorProps={{ sx: { height: 2 } }}
              value={responseTab}
              variant="scrollable"
              scrollButtons="auto"
            >
              <Tab label={t("composePage.tabs.overview")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="overview" />
              <Tab label={`${t("composePage.tabs.headers")} (${responseDetail.responseHeaders.length})`} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="headers" />
              <Tab label={t("composePage.tabs.json")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="json" />
              <Tab label={t("composePage.tabs.jsonText")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="jsonText" />
              <Tab label={t("composePage.tabs.raw")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="raw" />
              <Tab label={t("composePage.tabs.timing")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="timing" />
            </Tabs>
            <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0, gap: 0.25, pr: 1 }}>
              {showSearch && (
                <>
                  <IconButton
                    size="small"
                    disableRipple
                    title={t("inspector.response.jsonSearchPlaceholder")}
                    onClick={() => onSearchOpenChange(!searchOpen)}
                    color={searchOpen ? "primary" : "default"}
                  >
                    <SearchRoundedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                  <IconButton
                    size="small"
                    disableRipple
                    title={t("composePage.copyResponse")}
                    onClick={onCopyResponse}
                    disabled={!responseBodyText}
                  >
                    <ContentCopyRoundedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </>
              )}
            </Box>
          </Box>
          {showSearch && searchOpen && (
            <Box sx={{ flexShrink: 0, px: 1, py: 0.5 }}>
              <OutlinedInput
                autoFocus
                fullWidth
                placeholder={responseTab === "json" ? t("inspector.response.jsonSearchPlaceholder") : t("inspector.response.jsonTextSearchPlaceholder")}
                size="small"
                sx={{ fontFamily: appFontCssVars.content, fontSize: 12 }}
                value={searchValue}
                onChange={(event) => onSearchValueChange(event.target.value)}
              />
            </Box>
          )}
          <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pt: 1.5, px: 0.5 }}>
            {responseTabContent}
          </Box>
        </>
      ) : (
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }}>
          <Typography color="text.secondary" variant="body2">
            {t("composePage.configureHint")}
          </Typography>
        </Stack>
      )}
    </Box>
  );
}
