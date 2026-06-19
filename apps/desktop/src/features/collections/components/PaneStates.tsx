import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArticleRoundedIcon from "@mui/icons-material/ArticleRounded";
import { Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";

import type { TranslationKey } from "@/i18n";

export function LoadingState() {
  return (
    <Stack
      sx={{
        alignItems: "center",
        justifyContent: "center",
        minHeight: 140
      }}>
      <CircularProgress size={22} />
    </Stack>
  );
}

export function EmptyPaneState({
  actionLabel,
  icon,
  onAction,
  title,
}: {
  actionLabel?: string;
  icon: ReactNode;
  onAction?: () => void;
  title: string;
}) {
  return (
    <Stack
      spacing={1.25}
      sx={{
        alignItems: "center",
        justifyContent: "center",
        minHeight: 180,
        px: 2,
        textAlign: "center"
      }}>
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.06 : 0.045),
          borderRadius: 1,
          color: "text.secondary",
          display: "flex",
          height: 42,
          justifyContent: "center",
          width: 42,
          "& svg": { fontSize: 22 },
        })}
      >
        {icon}
      </Box>
      <Typography
        sx={{
          color: "text.secondary",
          fontSize: 12.5,
          lineHeight: 1.45
        }}>
        {title}
      </Typography>
      {actionLabel && onAction ? (
        <Button onClick={onAction} size="small" startIcon={<AddRoundedIcon />} variant="outlined">
          {actionLabel}
        </Button>
      ) : null}
    </Stack>
  );
}

export function EmptyWorkspace({
  collectionSelected,
  onCreateRequest,
  t,
}: {
  collectionSelected: boolean;
  onCreateRequest: () => void;
  t: (key: TranslationKey) => string;
}) {
  return (
    <Stack
      spacing={1.5}
      sx={{
        alignItems: "center",
        justifyContent: "center",
        flex: 1,
        px: 4,
        textAlign: "center"
      }}>
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.14 : 0.08),
          border: 1,
          borderColor: alpha(
            theme.palette.primary.main,
            theme.palette.mode === "dark" ? 0.24 : 0.16,
          ),
          borderRadius: 1.5,
          color: "primary.main",
          display: "flex",
          height: 64,
          justifyContent: "center",
          width: 64,
          "& svg": { fontSize: 34 },
        })}
      >
        <ArticleRoundedIcon />
      </Box>
      <Typography sx={{ fontSize: 18, fontWeight: 800 }}>
        {collectionSelected
          ? t("collectionsPage.readyToCreateRequest")
          : t("collectionsPage.noCollectionSelected")}
      </Typography>
      <Typography
        sx={{
          color: "text.secondary",
          fontSize: 13,
          maxWidth: 420
        }}>
        {collectionSelected
          ? t("collectionsPage.createRequestHint")
          : t("collectionsPage.selectCollectionHint")}
      </Typography>
      {collectionSelected ? (
        <Button onClick={onCreateRequest} startIcon={<AddRoundedIcon />} variant="contained">
          {t("collectionsPage.newRequest")}
        </Button>
      ) : null}
    </Stack>
  );
}
