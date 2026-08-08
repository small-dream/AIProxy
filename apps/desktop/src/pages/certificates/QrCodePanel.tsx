import { Box, Typography } from "@mui/material";
import { QRCodeSVG } from "qrcode.react";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

type Props = {
  certDownloadUrl: string | null;
  proxyAddress: string | null;
  sslEnabled: boolean;
  hasCert: boolean;
};

export function QrCodePanel({ certDownloadUrl, proxyAddress, sslEnabled, hasCert }: Props) {
  const { t } = useI18n();

  const showCertQr = sslEnabled && hasCert && certDownloadUrl;
  const showProxyQr = !sslEnabled && proxyAddress;

  return (
    <SectionCard
      compact
      title={t("certificatesPage.mobile.downloadCertificate")}
      description={t("certificatesPage.mobile.certQrHint")}
    >
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: showCertQr && showProxyQr ? "1fr 1fr" : "1fr" },
          gap: 1.5,
        }}
      >
        {showCertQr && (
          <Box sx={{ textAlign: "center" }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
              {t("certificatesPage.mobile.downloadCertificate")}
            </Typography>
            <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
              <Box sx={{ p: 2, bgcolor: "white", borderRadius: 1, display: "inline-block" }}>
                <QRCodeSVG value={certDownloadUrl} size={132} />
              </Box>
            </Box>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                fontFamily: fontFamilies.mono,
                wordBreak: "break-all",
                mt: 1,
              }}
            >
              {certDownloadUrl}
            </Typography>
          </Box>
        )}

        {showProxyQr && (
          <Box sx={{ textAlign: "center" }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
              {t("certificatesPage.mobile.proxyConfiguration")}
            </Typography>
            <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
              <Box sx={{ p: 2, bgcolor: "white", borderRadius: 1, display: "inline-block" }}>
                <QRCodeSVG value={`proxy:${proxyAddress}`} size={132} />
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </SectionCard>
  );
}
