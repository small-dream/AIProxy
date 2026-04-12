export type GuideStep = { order: number; description: string };

export const windowsSteps: GuideStep[] = [
  { order: 1, description: "Generate a root certificate above, then click Install Certificate... to open the Windows certificate installer." },
  { order: 2, description: "In the dialog, click Install Certificate..." },
  { order: 3, description: "Select Current User or Local Machine (Local Machine requires administrator), then click Next." },
  { order: 4, description: "Select 'Place all certificates in the following store', click Browse, and choose Trusted Root Certification Authorities. Click Next." },
  { order: 5, description: "Click Finish. Accept the security warning to confirm trust." },
  { order: 6, description: "Click Refresh Status to verify the certificate is now trusted." },
];

export const macosSteps: GuideStep[] = [
  { order: 1, description: "Double-click the certificate file to open it in Keychain Access." },
  { order: 2, description: "The certificate will appear in the 'login' keychain. Drag it to the 'System' keychain." },
  { order: 3, description: "Double-click the certificate in the System keychain, expand Trust, and set 'When using this certificate' to 'Always Trust'." },
  { order: 4, description: "Close the window. Enter your administrator password when prompted." },
  { order: 5, description: "Restart your browser for the change to take effect." },
];

export const linuxSteps: GuideStep[] = [
  { order: 1, description: "Copy the certificate to the system CA directory: sudo cp <cert-path> /usr/local/share/ca-certificates/pharles-root-ca.crt" },
  { order: 2, description: "Update the CA store: sudo update-ca-certificates" },
  { order: 3, description: "Restart your browser for the change to take effect." },
];
