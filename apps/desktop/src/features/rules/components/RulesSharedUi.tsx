import { type ReactNode } from "react";
import {
  Box,
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  OutlinedInput,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";

import { useI18n } from "@/i18n";
import { getHoverShadow, getSurfaceShadow } from "@/themes/app-theme";

/* ── FieldGroup ───────────────────────────────────────────────────── */

export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11 }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

/* ── InlineSwitch ─────────────────────────────────────────────────── */

export function InlineSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 40 }}>
      <Typography variant="body2">{label}</Typography>
      <Switch size="small" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Stack>
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
    <Stack spacing={2}>
      {/* Toolbar: create + search */}
      <Stack direction="row" spacing={1} alignItems="center">
        {createActions}
        <Box sx={{ flex: 1 }} />
        <OutlinedInput size="small" placeholder={searchPlaceholder} value={searchValue} onChange={(e) => onSearchChange(e.target.value)} sx={{ maxWidth: 200 }} />
      </Stack>

      {/* Rule list */}
      {list}

      {/* Editor */}
      {editor}
    </Stack>
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
      <Typography color="text.secondary" variant="body2" sx={{ py: 3, textAlign: "center" }}>
        {emptyDescription}
      </Typography>
    );
  }

  return (
    <Paper
      elevation={0}
      sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden", boxShadow: (theme) => getSurfaceShadow(theme.palette.mode) }}
    >
      <List disablePadding dense>
        {items.map((item, index) => (
          <Box key={item.id}>
            <ListItemButton
              selected={item.active}
              onClick={item.onClick}
              sx={{
                px: 1.5,
                py: 1,
                transition: "background-color 140ms ease",
                "&:hover": { boxShadow: (theme) => getHoverShadow(theme.palette.mode) },
              }}
            >
              <ListItemText
                primary={(
                  <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="center">
                    <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 13 }} noWrap>
                      {item.name}
                    </Typography>
                    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
                      {!item.enabled && <Chip size="small" label={t("rulesPage.off")} variant="outlined" sx={{ height: 20, fontSize: 11 }} />}
                      <Chip size="small" label={item.chipLabel} sx={{ height: 20, fontSize: 11 }} />
                    </Stack>
                  </Stack>
                )}
                secondary={(
                  <Typography sx={{ mt: 0.25 }} variant="caption" color="text.secondary" noWrap component="p">
                    {item.subtitle}
                  </Typography>
                )}
              />
            </ListItemButton>
            {index < items.length - 1 && <Divider />}
          </Box>
        ))}
      </List>
    </Paper>
  );
}
