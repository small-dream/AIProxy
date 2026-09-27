import { Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";

import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";
import { getAppBuildInfo } from "@/services/commands";
import { SettingsGroup, SettingsRow } from "../SettingsLayoutParts";

function BuildInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <SettingsRow label={label}>
      <Typography
        component="code"
        sx={{
          bgcolor: "action.hover",
          borderRadius: 1,
          fontFamily: "monospace",
          fontSize: 13,
          lineHeight: 1.6,
          maxWidth: "100%",
          overflowWrap: "anywhere",
          px: 1,
          py: 0.5,
        }}
      >
        {value}
      </Typography>
    </SettingsRow>
  );
}

export function AboutSection() {
  const { t } = useI18n();
  const { data: buildInfo } = useQuery({
    queryKey: ["app-build-info"],
    queryFn: getAppBuildInfo,
  });
  const version = buildInfo?.version ?? "0.1.0";
  const buildNumber = buildInfo?.buildNumber ?? "0";
  const versionIdentifier = buildInfo?.versionIdentifier ?? `${version}+${buildNumber}`;
  const commitHash = buildInfo?.commitHash ?? "dev";

  return (
    <SectionCard
      compact
      title={t("settingsPage.aboutSectionTitle")}
      description={t("settingsPage.aboutSectionDescription")}
    >
      <SettingsGroup>
        <BuildInfoRow label={t("settingsPage.aboutVersion")} value={version} />
        <BuildInfoRow label={t("settingsPage.aboutBuildNumber")} value={buildNumber} />
        <BuildInfoRow label={t("settingsPage.aboutCommitHash")} value={commitHash} />
        <BuildInfoRow label={t("settingsPage.aboutVersionIdentifier")} value={versionIdentifier} />
      </SettingsGroup>
    </SectionCard>
  );
}
