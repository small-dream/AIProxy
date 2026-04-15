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
            const filledStyles =
              tone === "error"
                ? {
                    bgcolor: theme.palette.error.main,
                    color: theme.palette.error.contrastText,
                    "&:hover": {
                      bgcolor: theme.palette.error.dark,
                    },
                  }
                : tone === "success"
                  ? {
                      bgcolor: theme.palette.success.main,
                      color: theme.palette.success.contrastText,
                      "&:hover": {
                        bgcolor: theme.palette.success.dark,
                      },
                    }
                  : tone === "primary"
                    ? {
                        bgcolor: theme.palette.primary.main,
                        color: theme.palette.primary.contrastText,
                        "&:hover": {
                          bgcolor: theme.palette.primary.dark,
                        },
                      }
                    : {
                        bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.18 : 0.1),
                        color: theme.palette.text.primary,
                        "&:hover": {
                          bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.28 : 0.16),
                        },
                      };

            return {
              border: "1px solid",
              borderColor: variant === "outlined" ? theme.palette.divider : "transparent",
              borderRadius: 999,
              color: variant === "outlined" ? theme.palette.text.secondary : undefined,
              height: 34,
              transition: "background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease",
              width: 34,
              "& .MuiSvgIcon-root": {
                fontSize: 19,
              },
              "&:hover": {
                bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.12 : 0.06),
                borderColor: theme.palette.text.disabled,
                color: theme.palette.text.primary,
                transform: "translateY(-1px)",
              },
              "&.Mui-disabled": {
                borderColor: theme.palette.divider,
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
