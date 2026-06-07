import { useState } from "react";
import { Box, Button, Collapse, Tab, Tabs, Typography } from "@mui/material";
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

export function PlatformTrustGuide({ currentPlatform }: Props) {
  const { t, tList } = useI18n();
  const detectedPlatform = PLATFORMS.includes(currentPlatform as PlatformKey)
    ? (currentPlatform as PlatformKey)
    : "windows";
  const [showOthers, setShowOthers] = useState(false);
  const [otherTab, setOtherTab] = useState<PlatformKey>(detectedPlatform);

  const platformSteps: Record<PlatformKey, Step[]> = {
    windows: tList("certificatesPage.platformSteps.windows").map((desc, i) => ({
      order: i + 1,
      description: desc,
    })),
    macos: tList("certificatesPage.platformSteps.macos").map((desc, i) => ({
      order: i + 1,
      description: desc,
    })),
    linux: tList("certificatesPage.platformSteps.linux").map((desc, i) => ({
      order: i + 1,
      description: desc,
    })),
  };

  const platformLabels: Record<PlatformKey, string> = {
    windows: t("certificatesPage.platformLabels.windows"),
    macos: t("certificatesPage.platformLabels.macos"),
    linux: t("certificatesPage.platformLabels.linux"),
  };

  const otherPlatforms = PLATFORMS.filter((p) => p !== detectedPlatform);

  return (
    <SectionCard title={t("certificatesPage.guideTitle")}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {platformLabels[detectedPlatform]}
      </Typography>
      <StepList steps={platformSteps[detectedPlatform]} />

      <Button size="small" variant="text" onClick={() => setShowOthers((v) => !v)} sx={{ mt: 1 }}>
        {showOthers
          ? t("certificatesPage.hideOtherPlatforms")
          : t("certificatesPage.showOtherPlatforms")}
      </Button>

      <Collapse in={showOthers}>
        <Box sx={{ mt: 1 }}>
          <Tabs
            value={otherTab}
            onChange={(_, v: PlatformKey) => setOtherTab(v)}
            sx={{ borderBottom: 1, borderColor: "divider", mb: 1 }}
          >
            {otherPlatforms.map((p) => (
              <Tab key={p} label={platformLabels[p]} value={p} />
            ))}
          </Tabs>
          <StepList steps={platformSteps[otherTab]} />
        </Box>
      </Collapse>
    </SectionCard>
  );
}
