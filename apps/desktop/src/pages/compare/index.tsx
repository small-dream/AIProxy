import AutoFixHighRoundedIcon from "@mui/icons-material/AutoFixHighRounded";
import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import type { CompareMode } from "@aiproxy/shared-types";
import { useNavigate } from "react-router-dom";

import { AiSummaryPanel } from "@/features/session-compare/components/AiSummaryPanel";
import {
  RequestCompareControls,
  SessionCompareControls,
} from "@/features/session-compare/components/CompareControls";
import { DiffSectionCard } from "@/features/session-compare/components/DiffSectionCard";
import { SessionCompareWorkbench } from "@/features/session-compare/components/SessionCompareWorkbench";
import { useSessionCompare } from "@/features/session-compare/use-session-compare";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

export function ComparePage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const cmp = useSessionCompare();

  return (
    <Stack spacing={1.5} sx={{ height: "100%", minHeight: 0 }}>
      {cmp.isSessionsError && (
        <Alert severity="error">{t("common.errors.generic")}</Alert>
      )}
      <Stack
        direction={{ md: "row", xs: "column" }}
        spacing={1.25}
        sx={{
          alignItems: { md: "center", xs: "stretch" },
          justifyContent: "space-between"
        }}>
        <Stack spacing={0.25}>
          <Typography variant="h4" sx={{ fontSize: 28, lineHeight: 1.15 }}>
            {t("comparePage.title")}
          </Typography>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {cmp.compareMode === "request"
              ? t("comparePage.requestDescription")
              : t("comparePage.sessionDescription")}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} useFlexGap sx={{
          flexWrap: "wrap"
        }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<VisibilityRoundedIcon />}
            onClick={() => cmp.setPreviewOpen(true)}
            disabled={!cmp.displayPayload}
          >
            {t("comparePage.previewPayload")}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<AutoFixHighRoundedIcon />}
            onClick={cmp.handleGenerateSummary}
            disabled={!cmp.canGenerate || cmp.summaryMutation.isPending}
          >
            {cmp.summaryMutation.isPending
              ? t("comparePage.generating")
              : t("comparePage.generateSummary")}
          </Button>
        </Stack>
      </Stack>
      <Paper
        elevation={0}
        sx={{
          border: 1,
          borderColor: "divider",
          borderRadius: 2,
          p: 1.5,
          ...(cmp.isSessionsError ? { opacity: 0.4, pointerEvents: "none" } : {}),
        }}
      >
        <Stack spacing={1.5}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={cmp.compareMode}
            onChange={(_, value: CompareMode | null) => {
              if (value) {
                cmp.updateMode(value);
              }
            }}
          >
            <ToggleButton value="request">{t("comparePage.requestCompare")}</ToggleButton>
            <ToggleButton value="session">{t("comparePage.sessionCompare")}</ToggleButton>
          </ToggleButtonGroup>

          {cmp.compareMode === "request" ? (
            <RequestCompareControls
              includeBodyForAi={cmp.includeBodyForAi}
              leftId={cmp.leftId}
              loading={cmp.sessionsLoading}
              rightId={cmp.rightId}
              selectedLeft={cmp.selectedLeft}
              selectedRight={cmp.selectedRight}
              sessions={cmp.sessions}
              onIncludeBodyForAiChange={cmp.setIncludeBodyForAi}
              onSelectionChange={cmp.updateRequestSelection}
            />
          ) : (
            <SessionCompareControls
              domainFilter={cmp.effectiveDomainFilter}
              domainOptions={cmp.domainOptions}
              leftScopeId={cmp.leftScopeId}
              rightScopeId={cmp.rightScopeId}
              scopes={cmp.scopeOptions}
              onDomainFilterChange={cmp.updateDomainFilter}
              onSelectionChange={cmp.updateScopeSelection}
            />
          )}
        </Stack>
      </Paper>
      {cmp.isSameSelection ? (
        <Alert severity="warning">{t("comparePage.sameSessionWarning")}</Alert>
      ) : null}
      {cmp.compareMode === "request" && cmp.detailState.error ? (
        <Alert severity="error">{cmp.detailState.error}</Alert>
      ) : null}
      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { lg: "minmax(0, 1fr) minmax(320px, 0.36fr)", xs: "1fr" },
          minHeight: 0,
          flex: 1,
        }}
      >
        <Paper
          elevation={0}
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 2,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <Stack sx={{ height: "100%", minHeight: 0 }}>
            <Stack
              direction="row"
              spacing={1}
              sx={{
                alignItems: "center",
                borderBottom: 1,
                borderColor: "divider",
                px: 1.5,
                py: 1
              }}>
              <CompareArrowsRoundedIcon sx={{ color: "primary.main", fontSize: 20 }} />
              <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
                {cmp.compareMode === "request"
                  ? t("comparePage.diffWorkbench")
                  : t("comparePage.behaviorWorkbench")}
              </Typography>
              {cmp.compareMode === "request" && cmp.detailState.loading ? (
                <Typography component="span" variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  {t("comparePage.loadingDetails")}
                </Typography>
              ) : null}
            </Stack>
            <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
              {cmp.compareMode === "request" ? (
                !cmp.requestDisplayPayload ? (
                  <Alert severity="info">{t("comparePage.requestEmptyState")}</Alert>
                ) : (
                  <Stack spacing={1.25}>
                    {cmp.requestDisplayPayload.sections.map((section) => (
                      <DiffSectionCard
                        key={section.key}
                        bodyDiffExpanded={cmp.expandedBodySections.has(section.key)}
                        displayExpanded={cmp.expandedEntrySections.has(section.key)}
                        section={section}
                        onToggleBodyDiff={() => cmp.toggleBodySection(section.key)}
                        onToggleDisplay={() => cmp.toggleEntrySection(section.key)}
                      />
                    ))}
                  </Stack>
                )
              ) : (
                <SessionCompareWorkbench
                  hasScopes={cmp.scopeOptions.length > 0}
                  payload={cmp.sessionPayload}
                />
              )}
            </Box>
          </Stack>
        </Paper>

        <AiSummaryPanel
          aiConfigured={cmp.aiConfigured}
          model={cmp.aiSettings?.model}
          mutationData={cmp.summaryMutation.data?.summary}
          mutationError={cmp.summaryMutation.error}
          onConfigure={() => navigate("/settings")}
        />
      </Box>
      <Dialog open={cmp.previewOpen} onClose={() => cmp.setPreviewOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{t("comparePage.previewPayload")}</DialogTitle>
        <DialogContent>
          <Typography
            component="pre"
            sx={{
              bgcolor: "background.default",
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              fontFamily: fontFamilies.mono,
              fontSize: 12,
              maxHeight: 520,
              overflow: "auto",
              p: 1.25,
              whiteSpace: "pre-wrap",
            }}
          >
            {cmp.previewText || t("common.empty.noData")}
          </Typography>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
