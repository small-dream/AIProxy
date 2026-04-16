import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import KeyboardArrowUpRoundedIcon from "@mui/icons-material/KeyboardArrowUpRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Box, IconButton, OutlinedInput, Stack, Tooltip, Typography } from "@mui/material";
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

  return (
    <Stack
      alignItems="center"
      direction="row"
      spacing={0.5}
      sx={{ borderBottom: 1, borderColor: "divider", px: 1, py: 0.5 }}
    >
      <OutlinedInput
        autoFocus
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
        startAdornment={<SearchRoundedIcon fontSize="small" sx={{ color: "text.secondary", mr: 1 }} />}
        sx={{ minWidth: 240 }}
        value={query}
      />

      <Tooltip arrow title={t("inspector.search.caseSensitive")}>
        <IconButton
          onClick={() => toggleOption("caseSensitive")}
          size="small"
          sx={{
            color: options.caseSensitive ? "primary.main" : "text.secondary",
            minWidth: 28,
            p: 0.25,
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <Typography fontSize={12} fontWeight={600} sx={{ lineHeight: 1 }}>
            Aa
          </Typography>
        </IconButton>
      </Tooltip>

      <Tooltip arrow title={t("inspector.search.wholeWord")}>
        <span>
          <IconButton
            disabled={options.useRegex}
            onClick={() => toggleOption("wholeWord")}
            size="small"
            sx={{
              color: options.wholeWord ? "primary.main" : "text.secondary",
              minWidth: 28,
              p: 0.25,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Typography fontSize={12} fontWeight={600} sx={{ lineHeight: 1 }}>
              ab
            </Typography>
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip arrow title={t("inspector.search.regex")}>
        <IconButton
          onClick={() => toggleOption("useRegex")}
          size="small"
          sx={{
            color: options.useRegex ? "primary.main" : "text.secondary",
            minWidth: 28,
            p: 0.25,
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <Box component="span" sx={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, lineHeight: 1 }}>
            .*
          </Box>
        </IconButton>
      </Tooltip>

      <Typography
        sx={{
          color: regexInvalid ? "error.main" : "text.secondary",
          fontSize: 12,
          lineHeight: 1,
          minWidth: 60,
          textAlign: "center",
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
            sx={{ color: "text.secondary", p: 0.25 }}
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
            sx={{ color: "text.secondary", p: 0.25 }}
          >
            <KeyboardArrowDownRoundedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip arrow title={t("inspector.search.close")}>
        <IconButton
          onClick={onClose}
          size="small"
          sx={{ color: "text.secondary", p: 0.25 }}
        >
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
