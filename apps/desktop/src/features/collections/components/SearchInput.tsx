import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { InputAdornment, OutlinedInput } from "@mui/material";
import { alpha } from "@mui/material/styles";

export function SearchInput({
  disabled = false,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <OutlinedInput
      disabled={disabled}
      fullWidth
      placeholder={placeholder}
      size="small"
      startAdornment={
        <InputAdornment position="start">
          <SearchRoundedIcon sx={{ color: "text.secondary", fontSize: 17 }} />
        </InputAdornment>
      }
      sx={(theme) => ({
        bgcolor: alpha(
          theme.palette.background.default,
          theme.palette.mode === "dark" ? 0.28 : 0.52,
        ),
        fontSize: 12.25,
        "& .MuiOutlinedInput-input": {
          py: 0.75,
        },
      })}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
