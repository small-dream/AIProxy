import { useState } from "react";
import { Box, Tab, Tabs, Typography } from "@mui/material";
import { SectionCard } from "@/components/shared/SectionCard";
import { windowsSteps, macosSteps, linuxSteps } from "./certificate-guides";

type Step = { order: number; description: string };

function StepList({ steps }: { steps: Step[] }) {
  return (
    <Box component="ol" sx={{ pl: 2, m: 0 }}>
      {steps.map((step) => (
        <li key={step.order}>
          <Typography variant="body2" sx={{ mb: 1 }}>{step.description}</Typography>
        </li>
      ))}
    </Box>
  );
}

const PLATFORMS = ["windows", "macos", "linux"] as const;
type PlatformKey = typeof PLATFORMS[number];

const platformSteps: Record<PlatformKey, Step[]> = {
  windows: windowsSteps,
  macos: macosSteps,
  linux: linuxSteps,
};

const platformLabels: Record<PlatformKey, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

type Props = {
  currentPlatform: string;
};

export function PlatformGuideTabs({ currentPlatform }: Props) {
  const initialTab = PLATFORMS.includes(currentPlatform as PlatformKey)
    ? currentPlatform as PlatformKey
    : "windows";
  const [activeTab, setActiveTab] = useState<PlatformKey>(initialTab);

  return (
    <SectionCard title="Installation Guide" description="Steps to trust the root CA certificate on your platform.">
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
