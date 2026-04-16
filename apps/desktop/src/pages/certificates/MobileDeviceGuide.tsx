import { useState } from "react";
import {
  Box,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

type MobileTab = "ios" | "android";

export function MobileDeviceGuide() {
  const { t, tList } = useI18n();
  const [activeTab, setActiveTab] = useState<MobileTab>("ios");

  const guideSteps =
    activeTab === "ios"
      ? tList("certificatesPage.mobile.iosSteps")
      : tList("certificatesPage.mobile.androidSteps");

  return (
    <SectionCard title={t("certificatesPage.mobile.setupGuide")} description={t("certificatesPage.mobile.sectionDescription")}>
      <Stack spacing={2}>
        <Tabs
          value={activeTab}
          onChange={(_, v: MobileTab) => setActiveTab(v)}
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label={t("certificatesPage.mobile.ios")} value="ios" />
          <Tab label={t("certificatesPage.mobile.android")} value="android" />
        </Tabs>

        <Box component="ol" sx={{ pl: 2, m: 0 }}>
          {guideSteps.map((step, index) => (
            <li key={`${activeTab}-${index}`}>
              <Typography variant="body2" sx={{ mb: 1 }}>{step}</Typography>
            </li>
          ))}
        </Box>
      </Stack>
    </SectionCard>
  );
}
