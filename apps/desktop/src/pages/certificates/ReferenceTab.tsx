import { Stack } from "@mui/material";
import { CertificateRiskNotes } from "./CertificateRiskNotes";
import { PlatformGuideTabs } from "./PlatformGuideTabs";

type Props = {
  currentPlatform: string;
};

export function ReferenceTab({ currentPlatform }: Props) {
  return (
    <Stack spacing={2}>
      <CertificateRiskNotes />
      <PlatformGuideTabs currentPlatform={currentPlatform} />
    </Stack>
  );
}
