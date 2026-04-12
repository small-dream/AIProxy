import { Alert, AlertTitle, Stack } from "@mui/material";
import { SectionCard } from "@/components/shared/SectionCard";

export function CertificateRiskNotes() {
  return (
    <SectionCard title="Risk Notes" description="Important information about HTTPS interception.">
      <Stack spacing={2}>
        <Alert severity="warning">
          <AlertTitle>Man-in-the-Middle by Design</AlertTitle>
          HTTPS decryption works by acting as a trusted middleman between your browser and the target server.
          All HTTPS traffic sent through the proxy can be inspected in plaintext.
          This is the intended behavior for debugging, but the root CA private key must be kept secure.
        </Alert>

        <Alert severity="info">
          <AlertTitle>How to Undo</AlertTitle>
          Removing the Pharles root CA from your system trust store restores normal HTTPS behavior.
          All traffic intercepted through this proxy stops the moment you stop the proxy or remove the certificate.
        </Alert>

        <Alert severity="info">
          <AlertTitle>Certificate Pinning</AlertTitle>
          Some applications use certificate pinning and will refuse to connect through a proxy with a custom root CA.
          This is a client-side security feature and cannot be bypassed by the proxy.
        </Alert>
      </Stack>
    </SectionCard>
  );
}
