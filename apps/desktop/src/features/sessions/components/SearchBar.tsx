import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import KeyboardArrowUpRoundedIcon from "@mui/icons-material/KeyboardArrowUpRounded";
import { Box, IconButton, OutlinedInput, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useRef } from "react";

import { useI18n } from "@/i18n";
import type { SearchOptions } from "./session-inspector.helpers";

export type SearchBarProps = {
  currentMatchIndex: number;
  matchCount: number;
  onClose: () => void;
  onNext: () => void;
  onOptionsChange: (options: SearchOptions) => void;
  onPrevious: () => void;
  onQueryChange: (query: string) => void;
  options: SearchOptions;
  placeholder?: string;
  query: string;
  regexInvalid?: boolean;
};

export function SearchBar({
  currentMatchIndex,
  matchCount,
  onClose,
  onNext,
  onOptionsChange,
  onPrevious,
  onQueryChange,
  options,
  placeholder,
  query,
  regexInvalid,
}: SearchBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  function toggleOption(key: keyof SearchOptions) {
    const next = { ...options, [key]: !options[key] };
    if (key === "useRegex" && next.useRegex) {
      next.wholeWord = false;
    }
    onOptionsChange(next);
  }

  const matchLabel =
    query.trim().length === 0
      ? ""
      : regexInvalid
        ? t("inspector.search.regexInvalid")
        : matchCount === 0
          ? t("inspector.search.noResults")
          : `${currentMatchIndex + 1} of ${matchCount}`;

  const buildOptionButtonSx = (active: boolean, disabled = false) => ({
    borderRadius: 0.75,
    color: disabled ? "action.disabled" : active ? "text.primary" : "text.secondary",
    height: 22,
    minWidth: 22,
    p: 0.25,
    transition: "background-color 120ms ease, color 120ms ease",
    ...(active ? { bgcolor: "action.selected" } : {}),
    ...(!disabled
      ? {
          "&:hover": {
            bgcolor: active ? "action.selected" : "action.hover",
            color: "text.primary",
          },
        }
      : {}),
  });

  return (
    <Stack
      alignItems="center"
      direction="row"
      spacing={0.5}
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        boxShadow: (theme) =>
          theme.palette.mode === "dark"
            ? "0 10px 24px rgba(0, 0, 0, 0.32)"
            : "0 8px 18px rgba(15, 23, 42, 0.12)",
        minHeight: 38,
        px: 0.75,
        py: 0.5,
        width: "fit-content",
      }}
    >
      <OutlinedInput
        autoFocus
        endAdornment={
          <Box
            sx={{
              alignItems: "center",
              borderLeft: 1,
              borderColor: "divider",
              display: "flex",
              gap: 0.25,
              ml: 0.75,
              pl: 0.5,
            }}
          >
            <Tooltip arrow title={t("inspector.search.caseSensitive")}>
              <IconButton
                aria-label={t("inspector.search.caseSensitive")}
                onClick={() => toggleOption("caseSensitive")}
                size="small"
                sx={buildOptionButtonSx(options.caseSensitive)}
              >
                <Typography fontSize={11} fontWeight={700} sx={{ letterSpacing: 0.1, lineHeight: 1 }}>
                  Aa
                </Typography>
              </IconButton>
            </Tooltip>

            <Tooltip arrow title={t("inspector.search.wholeWord")}>
              <span>
                <IconButton
                  aria-label={t("inspector.search.wholeWord")}
                  disabled={options.useRegex}
                  onClick={() => toggleOption("wholeWord")}
                  size="small"
                  sx={buildOptionButtonSx(options.wholeWord, options.useRegex)}
                >
                  <Typography fontSize={11} fontWeight={700} sx={{ letterSpacing: 0.1, lineHeight: 1 }}>
                    ab
                  </Typography>
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip arrow title={t("inspector.search.regex")}>
              <IconButton
                aria-label={t("inspector.search.regex")}
                onClick={() => toggleOption("useRegex")}
                size="small"
                sx={buildOptionButtonSx(options.useRegex)}
              >
                <Box component="span" sx={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, letterSpacing: -0.2, lineHeight: 1 }}>
                  .*
                </Box>
              </IconButton>
            </Tooltip>
          </Box>
        }
        inputRef={inputRef}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              onPrevious();
            } else {
              onNext();
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={placeholder}
        size="small"
        sx={{
          bgcolor: (theme) => alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.06 : 0.025),
          borderRadius: 1,
          flex: "0 1 340px",
          minWidth: 190,
          "& .MuiInputBase-input": {
            fontSize: 13,
            px: 1.25,
            py: 0.75,
          },
          "& .MuiOutlinedInput-notchedOutline": {
            borderColor: regexInvalid ? "error.main" : "divider",
          },
          "&:hover .MuiOutlinedInput-notchedOutline": {
            borderColor: regexInvalid ? "error.main" : "text.secondary",
          },
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: regexInvalid ? "error.main" : "primary.main",
            borderWidth: 1,
          },
        }}
        value={query}
      />

      <Typography
        sx={{
          color: regexInvalid ? "error.main" : "text.secondary",
          fontSize: 12,
          lineHeight: 1,
          minWidth: 52,
          textAlign: "left",
          whiteSpace: "nowrap",
        }}
      >
        {matchLabel}
      </Typography>

      <Tooltip arrow title={t("inspector.search.previousMatch")}>
        <span>
          <IconButton
            disabled={matchCount === 0}
            onClick={onPrevious}
            size="small"
            sx={{
              borderRadius: 0.75,
              color: "text.secondary",
              p: 0.25,
              "&:hover": { bgcolor: "action.hover", color: "text.primary" },
            }}
          >
            <KeyboardArrowUpRoundedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip arrow title={t("inspector.search.nextMatch")}>
        <span>
          <IconButton
            disabled={matchCount === 0}
            onClick={onNext}
            size="small"
            sx={{
              borderRadius: 0.75,
              color: "text.secondary",
              p: 0.25,
              "&:hover": { bgcolor: "action.hover", color: "text.primary" },
            }}
          >
            <KeyboardArrowDownRoundedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip arrow title={t("inspector.search.close")}>
        <IconButton
          onClick={onClose}
          size="small"
          sx={{
            borderRadius: 0.75,
            color: "text.secondary",
            p: 0.25,
            "&:hover": { bgcolor: "action.hover", color: "text.primary" },
          }}
        >
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
