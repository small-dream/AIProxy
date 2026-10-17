import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import { Box, IconButton, Stack, Tooltip, Typography } from "@mui/material";

type AgentPathValueProps = {
  copyLabel: string;
  label?: string;
  onCopy: (value: string) => void;
  value: string;
};

export function AgentPathValue({ copyLabel, label, onCopy, value }: AgentPathValueProps) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
      {label ? (
        <Typography variant="caption" sx={{ color: "text.secondary", flexShrink: 0, width: 104 }}>
          {label}
        </Typography>
      ) : null}
      <Tooltip
        title={value}
        placement="top"
        slotProps={{ tooltip: { sx: { maxWidth: 520, overflowWrap: "anywhere" } } }}
      >
        <Box sx={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
          <Typography variant="body2" noWrap sx={{ fontFamily: "monospace", fontSize: 12.5 }}>
            {value}
          </Typography>
        </Box>
      </Tooltip>
      <Tooltip title={copyLabel}>
        <IconButton
          size="small"
          aria-label={`${copyLabel}: ${label ?? value}`}
          onClick={() => onCopy(value)}
          sx={{ flexShrink: 0 }}
        >
          <ContentCopyRoundedIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
