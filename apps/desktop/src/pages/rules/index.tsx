import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type { BreakpointRule, BreakpointStage } from "@pharles/shared-types";
import { useState } from "react";

import { SectionCard } from "@/components/shared/SectionCard";
import { useBreakpointRules, useSetBreakpointRules } from "@/features/breakpoints/use-breakpoint-rules";
import { useI18n } from "@/i18n";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function createEmptyRule(): BreakpointRule {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    urlPattern: "",
    methods: [],
    stage: "request",
  };
}

export function RulesPage() {
  const { t } = useI18n();
  const { data: rules = [] } = useBreakpointRules();
  const setRulesMutation = useSetBreakpointRules();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<BreakpointRule>(createEmptyRule());

  function handleSave() {
    setRulesMutation.mutate([...rules, draft]);
    setDialogOpen(false);
    setDraft(createEmptyRule());
  }

  function handleToggle(id: string) {
    setRulesMutation.mutate(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }

  function handleDelete(id: string) {
    setRulesMutation.mutate(rules.filter((r) => r.id !== id));
  }

  function handleAddCatchAll(stage: BreakpointStage) {
    const catchAll: BreakpointRule = {
      id: crypto.randomUUID(),
      enabled: true,
      urlPattern: "*",
      methods: [],
      stage,
    };
    setRulesMutation.mutate([...rules, catchAll]);
  }

  const hasRequestCatchAll = rules.some((r) => r.enabled && r.urlPattern === "*" && r.stage === "request" && r.methods.length === 0);
  const hasResponseCatchAll = rules.some((r) => r.enabled && r.urlPattern === "*" && r.stage === "response" && r.methods.length === 0);

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">{t("rulesPage.title")}</Typography>
        <Typography color="text.secondary" variant="body1">
          {t("rulesPage.description")}
        </Typography>
      </Stack>

      {/* Quick actions */}
      <SectionCard title={t("rulesPage.quickBreakpointTitle")} description={t("rulesPage.quickBreakpointDescription")}>
        <Stack direction="row" spacing={1.5}>
          <Button
            variant="outlined"
            size="small"
            disabled={hasRequestCatchAll}
            onClick={() => handleAddCatchAll("request")}
          >
            {t("rulesPage.breakOnAllRequests")}
          </Button>
          <Button
            variant="outlined"
            size="small"
            disabled={hasResponseCatchAll}
            onClick={() => handleAddCatchAll("response")}
          >
            {t("rulesPage.breakOnAllResponses")}
          </Button>
        </Stack>
      </SectionCard>

      {/* Rule list */}
      <SectionCard title={t("rulesPage.breakpointRulesTitle")} description={t("rulesPage.breakpointRulesDescription")}>
        {rules.length === 0 ? (
          <Typography color="text.secondary" variant="body2" sx={{ py: 1 }}>
            {t("rulesPage.empty")}
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 56 }}>{t("rulesPage.table.on")}</TableCell>
                <TableCell>{t("rulesPage.table.urlPattern")}</TableCell>
                <TableCell sx={{ width: 180 }}>{t("rulesPage.table.methods")}</TableCell>
                <TableCell sx={{ width: 100 }}>{t("rulesPage.table.stage")}</TableCell>
                <TableCell sx={{ width: 48 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Switch size="small" checked={rule.enabled} onChange={() => handleToggle(rule.id)} />
                  </TableCell>
                  <TableCell>
                    <Typography sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13 }}>
                      {rule.urlPattern || "*"}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {rule.methods.length === 0 ? (
                      <Chip label={t("rulesPage.labels.all")} size="small" variant="outlined" sx={{ fontSize: 11 }} />
                    ) : (
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {rule.methods.map((m) => (
                          <Chip key={m} label={m} size="small" sx={{ fontSize: 10 }} />
                        ))}
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={rule.stage === "request" ? t("rulesPage.stages.request") : t("rulesPage.stages.response")}
                      size="small"
                      color={rule.stage === "request" ? "info" : "secondary"}
                      variant="outlined"
                      sx={{ fontSize: 11, textTransform: "capitalize" }}
                    />
                  </TableCell>
                  <TableCell>
                    <IconButton size="small" color="error" onClick={() => handleDelete(rule.id)}>
                      <DeleteRoundedIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {/* Add rule button */}
      <Box>
        <Button
          variant="contained"
          startIcon={<AddRoundedIcon />}
          onClick={() => {
            setDraft(createEmptyRule());
            setDialogOpen(true);
          }}
        >
          {t("rulesPage.addRule")}
        </Button>
      </Box>

      {/* Add rule dialog */}
      <Dialog fullWidth maxWidth="sm" onClose={() => setDialogOpen(false)} open={dialogOpen}>
        <DialogTitle>{t("rulesPage.addDialogTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <OutlinedInput
              placeholder={t("rulesPage.urlPatternPlaceholder")}
              value={draft.urlPattern}
              onChange={(e) => setDraft({ ...draft, urlPattern: e.target.value })}
              fullWidth
              sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13 }}
            />
            <FormControl size="small" fullWidth>
              <InputLabel>{t("rulesPage.labels.httpMethods")}</InputLabel>
              <Select
                multiple
                value={draft.methods}
                onChange={(e) => setDraft({ ...draft, methods: e.target.value as string[] })}
                input={<OutlinedInput label={t("rulesPage.labels.httpMethods")} />}
                renderValue={(selected) => (selected.length === 0 ? t("rulesPage.allMethods") : selected.join(", "))}
              >
                {HTTP_METHODS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>{t("rulesPage.labels.stage")}</InputLabel>
              <Select
                value={draft.stage}
                label={t("rulesPage.labels.stage")}
                onChange={(e) => setDraft({ ...draft, stage: e.target.value as BreakpointStage })}
              >
                <MenuItem value="request">{t("rulesPage.requestStageOption")}</MenuItem>
                <MenuItem value="response">{t("rulesPage.responseStageOption")}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <Divider />
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)}>{t("common.actions.cancel")}</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={setRulesMutation.isPending}
          >
            {t("rulesPage.addRule")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
