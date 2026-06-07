import { type ReactNode } from "react";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Box,
  Chip,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  OutlinedInput,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";

import { useI18n } from "@/i18n";
import type { TranslationFn } from "@/features/rules/rules.helpers";
import { fontFamilies } from "@/themes/fonts";

export function formatRuleFieldLabel(
  label: string,
  requirement: "optional" | "required",
  t: TranslationFn,
) {
  const hint =
    requirement === "required"
      ? t("rulesPage.fieldHints.required")
      : t("rulesPage.fieldHints.optional");

  return `${label} (${hint})`;
}

/* ── FieldGroup ───────────────────────────────────────────────────── */

export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={1.5}>
      <Typography
        variant="subtitle2"
        color="text.secondary"
        sx={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0,
          textTransform: "uppercase",
        }}
      >
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

/* ── InlineSwitch ─────────────────────────────────────────────────── */

export function InlineSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{
        bgcolor: (theme) =>
          alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.04 : 0.035),
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        minHeight: 36,
        px: 1,
      }}
    >
      <Typography variant="body2" sx={{ fontSize: 13 }}>
        {label}
      </Typography>
      <Switch size="small" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Stack>
  );
}

/* ── RuleSection ─────────────────────────────────────────────────── */

export function RuleSection({ children }: { children: ReactNode }) {
  return (
    <Paper
      elevation={0}
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        p: 2,
        "& .MuiInputLabel-root.MuiInputLabel-shrink": {
          bgcolor: "background.paper",
          px: 0.5,
        },
      }}
    >
      {children}
    </Paper>
  );
}

/* ── ManagedRulesWorkbench ────────────────────────────────────────── */

export function ManagedRulesWorkbench(props: {
  createActions: ReactNode;
  editor: ReactNode;
  list: ReactNode;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchValue: string;
}) {
  const { createActions, editor, list, onSearchChange, searchPlaceholder, searchValue } = props;

  return (
    <Box
      sx={{
        display: "grid",
        gap: 0,
        gridTemplateColumns: {
          xs: "minmax(0, 1fr)",
          lg: "340px 6px minmax(0, 1fr)",
          xl: "360px 6px minmax(0, 1fr)",
        },
        height: "100%",
        minHeight: 0,
      }}
    >
      <Paper
        elevation={0}
        sx={{
          alignSelf: "stretch",
          bgcolor: (theme) =>
            theme.palette.mode === "dark"
              ? alpha(theme.palette.background.default, 0.18)
              : alpha(theme.palette.background.default, 0.36),
          border: 0,
          borderColor: "divider",
          borderRadius: 0,
          borderBottom: { lg: 0, xs: 1 },
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: { xs: 280, lg: 0 },
          overflow: "hidden",
        }}
      >
        <Stack spacing={1.25} sx={{ borderBottom: 1, borderColor: "divider", p: 1.5 }}>
          <OutlinedInput
            size="small"
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            startAdornment={
              <InputAdornment position="start">
                <SearchRoundedIcon sx={{ color: "text.secondary", fontSize: 18 }} />
              </InputAdornment>
            }
            sx={{
              bgcolor: "background.paper",
              fontSize: 13,
              height: 36,
            }}
          />
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {createActions}
          </Stack>
        </Stack>

        <Box sx={{ flex: 1, minHeight: 220, overflow: "auto", p: 1 }}>{list}</Box>
      </Paper>

      <Box
        aria-hidden
        sx={{
          alignItems: "center",
          display: { lg: "flex", xs: "none" },
          justifyContent: "center",
          minHeight: 0,
          "&::before": {
            bgcolor: (theme) =>
              alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.46 : 0.62),
            borderRadius: 999,
            content: '""',
            height: "100%",
            width: 1,
          },
        }}
      />

      <Paper
        elevation={0}
        sx={{
          bgcolor: "transparent",
          border: 0,
          borderColor: "divider",
          borderRadius: 0,
          height: "100%",
          minWidth: 0,
          overflow: "auto",
          p: 2,
        }}
      >
        {editor}
      </Paper>
    </Box>
  );
}

/* ── ManagedRuleList ──────────────────────────────────────────────── */

export function ManagedRuleList(props: {
  emptyDescription: string;
  items: Array<{
    active: boolean;
    chipLabel: string;
    enabled: boolean;
    id: string;
    name: string;
    onClick: () => void;
    subtitle: string;
  }>;
}) {
  const { t } = useI18n();
  const { emptyDescription, items } = props;

  if (items.length === 0) {
    return (
      <Box
        sx={{
          alignItems: "center",
          border: 1,
          borderColor: "divider",
          borderRadius: "8px",
          color: "text.secondary",
          display: "flex",
          minHeight: 180,
          px: 2,
          textAlign: "center",
        }}
      >
        <Typography variant="body2" sx={{ fontSize: 13 }}>
          {emptyDescription}
        </Typography>
      </Box>
    );
  }

  return (
    <List disablePadding dense sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      {items.map((item) => (
        <ListItemButton
          key={item.id}
          selected={item.active}
          onClick={item.onClick}
          sx={{
            border: 1,
            borderColor: item.active ? "primary.main" : "divider",
            borderRadius: "8px",
            overflow: "hidden",
            px: 1.25,
            py: 1,
            transition:
              "border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease",
            "&.Mui-selected": {
              bgcolor: (theme) =>
                alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.08),
            },
            "&:hover": {
              bgcolor: (theme) =>
                alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.13 : 0.055),
              borderColor: (theme) => alpha(theme.palette.primary.main, 0.45),
            },
          }}
        >
          <ListItemText
            primary={
              <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="center">
                <Typography variant="body2" sx={{ fontWeight: 650, fontSize: 13 }} noWrap>
                  {item.name}
                </Typography>
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
                  {!item.enabled && (
                    <Chip
                      size="small"
                      label={t("rulesPage.off")}
                      variant="outlined"
                      sx={{ height: 20, fontSize: 11 }}
                    />
                  )}
                  <Chip
                    size="small"
                    label={item.chipLabel}
                    variant={item.active ? "filled" : "outlined"}
                    sx={{
                      fontFamily: fontFamilies.mono,
                      fontSize: 11,
                      height: 20,
                    }}
                  />
                </Stack>
              </Stack>
            }
            secondary={
              <Typography
                sx={{ mt: 0.35 }}
                variant="caption"
                color="text.secondary"
                noWrap
                component="p"
              >
                {item.subtitle}
              </Typography>
            }
          />
        </ListItemButton>
      ))}
    </List>
  );
}
