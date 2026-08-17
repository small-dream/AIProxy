import { Chip, IconButton, MenuItem, Select, Stack, Typography } from "@mui/material";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

type Props = {
  localIp: string | null;
  /** Full detected address list; drives the multi-adapter switcher. */
  ips?: readonly string[] | undefined;
  ipsLoading: boolean;
  onSelectIp?: (ip: string) => void;
  proxyPort: number;
  proxyAddress: string | null;
};

export function NetworkInfoPanel({
  localIp,
  ips,
  ipsLoading,
  onSelectIp,
  proxyPort,
  proxyAddress,
}: Props) {
  const { t } = useI18n();

  const handleCopyProxy = () => {
    if (proxyAddress) {
      navigator.clipboard.writeText(proxyAddress);
    }
  };

  const canSwitchIp = !ipsLoading && !!localIp && !!ips && ips.length > 1 && !!onSelectIp;

  return (
    <SectionCard
      compact
      title={t("certificatesPage.mobile.networkInfo")}
      description={t("certificatesPage.mobile.sectionDescription")}
    >
      <Stack spacing={1.1}>
        <Stack
          direction="row"
          spacing={2}
          sx={{
            alignItems: "center",
          }}
        >
          <Typography variant="body2" sx={{ minWidth: 120 }}>
            {t("certificatesPage.mobile.localIp")}
          </Typography>
          {ipsLoading ? (
            <Chip label={t("common.states.detecting")} size="small" />
          ) : canSwitchIp ? (
            <Select
              size="small"
              value={localIp}
              onChange={(event) => onSelectIp(event.target.value)}
              title={t("certificatesPage.mobile.interfaceLabel")}
              sx={{
                fontFamily: fontFamilies.mono,
                fontWeight: 600,
                minWidth: 180,
                "& .MuiSelect-select": {
                  fontFamily: fontFamilies.mono,
                  fontWeight: 600,
                },
              }}
            >
              {ips.map((ip) => (
                <MenuItem key={ip} value={ip} sx={{ fontFamily: fontFamilies.mono }}>
                  {ip}
                </MenuItem>
              ))}
            </Select>
          ) : localIp ? (
            <Typography variant="body2" sx={{ fontFamily: fontFamilies.mono, fontWeight: 600 }}>
              {localIp}
            </Typography>
          ) : (
            <Chip label={t("common.states.notDetected")} color="error" size="small" />
          )}
        </Stack>

        <Stack
          direction="row"
          spacing={2}
          sx={{
            alignItems: "center",
          }}
        >
          <Typography variant="body2" sx={{ minWidth: 120 }}>
            {t("certificatesPage.mobile.proxyPort")}
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: fontFamilies.mono, fontWeight: 600 }}>
            {proxyPort}
          </Typography>
        </Stack>

        <Stack
          direction="row"
          spacing={2}
          sx={{
            alignItems: "center",
          }}
        >
          <Typography variant="body2" sx={{ minWidth: 120 }}>
            {t("certificatesPage.mobile.wifiProxy")}
          </Typography>
          {proxyAddress ? (
            <Stack
              direction="row"
              spacing={1}
              sx={{
                alignItems: "center",
              }}
            >
              <Typography
                variant="body2"
                sx={{ fontFamily: fontFamilies.mono, fontWeight: 600, color: "primary.main" }}
              >
                {proxyAddress}
              </Typography>
              <IconButton
                size="small"
                onClick={handleCopyProxy}
                title={t("certificatesPage.mobile.copyProxyAddress")}
              >
                <ContentCopyRoundedIcon fontSize="inherit" />
              </IconButton>
            </Stack>
          ) : (
            <Chip label={t("common.states.na")} size="small" />
          )}
        </Stack>
      </Stack>
    </SectionCard>
  );
}
