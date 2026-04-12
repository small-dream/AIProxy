import type { PropsWithChildren, ReactNode } from "react";
import { Card, CardContent, Stack, Typography } from "@mui/material";
import { radiusTokens } from "@pharles/ui-tokens";

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
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
        height: "100%",
        transition: "box-shadow 160ms ease, transform 160ms ease",
        "&:hover": {
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
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
