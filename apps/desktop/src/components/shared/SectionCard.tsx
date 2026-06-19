import type { PropsWithChildren, ReactNode } from "react";
import { Card, CardContent, Stack, Typography } from "@mui/material";
import { radiusTokens } from "@aiproxy/ui-tokens";

import { getHoverShadow, getSurfaceShadow } from "@/themes/app-theme";

type SectionCardProps = PropsWithChildren<{
  compact?: boolean;
  description?: string;
  title: string;
  toolbar?: ReactNode;
}>;

export function SectionCard({
  children,
  compact = false,
  description,
  title,
  toolbar,
}: SectionCardProps) {
  return (
    <Card
      elevation={0}
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: `${radiusTokens.card}px`,
        boxShadow: (theme) => (compact ? "none" : getSurfaceShadow(theme.palette.mode)),
        height: "100%",
        transition: "box-shadow 160ms ease, transform 160ms ease",
        "&:hover": {
          boxShadow: (theme) => (compact ? "none" : getHoverShadow(theme.palette.mode)),
          transform: compact ? "none" : "translateY(-1px)",
        },
      }}
    >
      <CardContent
        sx={{
          p: compact ? 2.5 : undefined,
          "&:last-child": {
            pb: compact ? 2.5 : undefined,
          },
        }}
      >
        <Stack direction="row" spacing={2} sx={{
          justifyContent: "space-between"
        }}>
          <Stack spacing={compact ? 0.25 : 0.5}>
            <Typography variant="h6" sx={compact ? { fontSize: 17, lineHeight: 1.25 } : undefined}>
              {title}
            </Typography>
            {description ? (
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {description}
              </Typography>
            ) : null}
          </Stack>
          {toolbar}
        </Stack>

        <Stack sx={{ mt: compact ? 2 : 3 }}>{children}</Stack>
      </CardContent>
    </Card>
  );
}
