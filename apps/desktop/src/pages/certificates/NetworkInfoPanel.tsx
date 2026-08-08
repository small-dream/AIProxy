import { Chip, IconButton, Stack, Typography } from "@mui/material";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

type Props = {
  localIp: string | null;
  ipsLoading: boolean;
  proxyPort: number;
  proxyAddress: string | null;
};

export function NetworkInfoPanel({ localIp, ipsLoading, proxyPort, proxyAddress }: Props) {
  const { t } = useI18n();

  const handleCopyProxy = () => {
    if (proxyAddress) {
      navigator.clipboard.writeText(proxyAddress);
    }
  };

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
