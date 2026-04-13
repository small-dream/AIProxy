import type { PropsWithChildren, ReactNode } from "react";
import { Card, CardContent, Stack, Typography } from "@mui/material";
import { radiusTokens } from "@pharles/ui-tokens";

import { getHoverShadow, getSurfaceShadow } from "@/themes/app-theme";

type SectionCardProps = PropsWithChildren<{
  description?: string;
  title: string;
  toolbar?: ReactNode;
}>;

export function SectionCard({ children, description, title, toolbar }: SectionCardProps) {
  return (
    <Card
      elevation={0}
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: `${radiusTokens.card}px`,
        boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
        height: "100%",
        transition: "box-shadow 160ms ease, transform 160ms ease",
        "&:hover": {
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
          transform: "translateY(-1px)",
        },
      }}
    >
      <CardContent>
        <Stack direction="row" justifyContent="space-between" spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="h6">{title}</Typography>
            {description ? (
              <Typography color="text.secondary" variant="body2">
                {description}
              </Typography>
            ) : null}
          </Stack>
          {toolbar}
        </Stack>

        <Stack sx={{ mt: 3 }}>{children}</Stack>
      </CardContent>
    </Card>
  );
}
