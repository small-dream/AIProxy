import { IconButton, Tooltip } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";

type TopBarActionTone = "default" | "error" | "primary" | "success";
type TopBarActionVariant = "filled" | "outlined";

type TopBarActionButtonProps = {
  ariaPressed?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: TopBarActionTone;
  variant?: TopBarActionVariant;
};

export function TopBarActionButton({
  ariaPressed,
  disabled = false,
  icon,
  label,
  onClick,
  tone = "default",
  variant = "outlined",
}: TopBarActionButtonProps) {
  return (
    <Tooltip arrow title={label}>
      <span>
        <IconButton
          aria-label={label}
          aria-pressed={ariaPressed}
          disabled={disabled}
          onClick={onClick}
          size="small"
          sx={(theme) => {
            const toneColor =
              tone === "error"
                ? theme.palette.error.main
                : tone === "success"
                  ? theme.palette.success.main
                  : tone === "primary"
                    ? theme.palette.primary.main
                    : theme.palette.text.primary;
            const filledStyles =
              tone === "error"
                ? {
                    bgcolor: alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.24 : 0.12),
                    borderColor: alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.34 : 0.2),
                    color: theme.palette.error.main,
                    "&:hover": {
                      bgcolor: alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.32 : 0.18),
                      borderColor: alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.48 : 0.32),
                    },
                  }
                : tone === "success"
                  ? {
                      bgcolor: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.24 : 0.12),
                      borderColor: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.34 : 0.2),
                      color: theme.palette.success.main,
                      "&:hover": {
                        bgcolor: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.32 : 0.18),
                        borderColor: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.48 : 0.32),
                      },
                    }
                  : tone === "primary"
                    ? {
                        bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.24 : 0.12),
                        borderColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.34 : 0.2),
                        color: theme.palette.primary.main,
                        "&:hover": {
                          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.32 : 0.18),
                          borderColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.48 : 0.32),
                        },
                      }
                    : {
                        bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.16 : 0.08),
                        borderColor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.22 : 0.12),
                        color: theme.palette.text.primary,
                        "&:hover": {
                          bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.22 : 0.12),
                          borderColor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.32 : 0.2),
                        },
                      };

            return {
              border: "1px solid",
              borderColor: variant === "outlined"
                ? "transparent"
                : alpha(toneColor, theme.palette.mode === "dark" ? 0.24 : 0.16),
              borderRadius: 999,
              color: variant === "outlined" ? theme.palette.text.secondary : undefined,
              height: 32,
              transition: "background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease, color 140ms ease, transform 140ms ease",
              width: 32,
              "& .MuiSvgIcon-root": {
                fontSize: 18,
              },
              "&:hover": {
                bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.12 : 0.06),
                borderColor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.2 : 0.12),
                boxShadow: theme.palette.mode === "dark"
                  ? "0 8px 18px rgba(0, 0, 0, 0.22)"
                  : "0 7px 16px rgba(15, 23, 42, 0.08)",
                color: theme.palette.text.primary,
                transform: "translateY(-1px)",
              },
              "&.Mui-disabled": {
                borderColor: "transparent",
                color: theme.palette.action.disabled,
              },
              ...(variant === "filled" ? filledStyles : null),
            };
          }}
        >
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}
