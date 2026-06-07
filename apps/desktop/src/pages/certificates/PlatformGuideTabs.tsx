import { useState } from "react";
import { Box, Tab, Tabs, Typography } from "@mui/material";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

type Step = { order: number; description: string };

function StepList({ steps }: { steps: Step[] }) {
  return (
    <Box component="ol" sx={{ pl: 2, m: 0 }}>
      {steps.map((step) => (
        <li key={step.order}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {step.description}
          </Typography>
        </li>
      ))}
    </Box>
  );
}

const PLATFORMS = ["windows", "macos", "linux"] as const;
type PlatformKey = (typeof PLATFORMS)[number];

type Props = {
  currentPlatform: string;
};

export function PlatformGuideTabs({ currentPlatform }: Props) {
  const { t, tList } = useI18n();
  const initialTab = PLATFORMS.includes(currentPlatform as PlatformKey)
    ? (currentPlatform as PlatformKey)
    : "windows";
  const [activeTab, setActiveTab] = useState<PlatformKey>(initialTab);
  const platformSteps: Record<PlatformKey, Step[]> = {
    windows: tList("certificatesPage.platformSteps.windows").map((description, index) => ({
      order: index + 1,
      description,
    })),
    macos: tList("certificatesPage.platformSteps.macos").map((description, index) => ({
      order: index + 1,
      description,
    })),
    linux: tList("certificatesPage.platformSteps.linux").map((description, index) => ({
      order: index + 1,
      description,
    })),
  };

  const platformLabels: Record<PlatformKey, string> = {
    windows: t("certificatesPage.platformLabels.windows"),
    macos: t("certificatesPage.platformLabels.macos"),
    linux: t("certificatesPage.platformLabels.linux"),
  };

  return (
    <SectionCard
      title={t("certificatesPage.guideTitle")}
      description={t("certificatesPage.guideDescription")}
    >
      <Tabs
        value={activeTab}
        onChange={(_, v: PlatformKey) => setActiveTab(v)}
        sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}
      >
        {PLATFORMS.map((p) => (
          <Tab key={p} label={platformLabels[p]} value={p} />
        ))}
      </Tabs>

      <StepList steps={platformSteps[activeTab]} />
    </SectionCard>
  );
}
