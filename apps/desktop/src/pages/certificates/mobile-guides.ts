export type MobileGuideStep = { order: number; description: string };

export const iosSteps: MobileGuideStep[] = [
  { order: 1, description: "Make sure your iPhone/iPad is connected to the same Wi-Fi network as this computer." },
  { order: 2, description: 'Go to Settings > Wi-Fi, tap the (i) button next to your connected network.' },
  { order: 3, description: 'Scroll to the bottom, tap "Configure Proxy", then select "Manual".' },
  { order: 4, description: 'Enter the Local IP shown above as the Server, and the Proxy Port as the Port. Tap Save.' },
  { order: 5, description: 'Scan the QR code above on your phone (or open the URL in Safari) to download the root CA certificate.' },
  { order: 6, description: 'Go to Settings > General > VPN & Device Management. Tap the Pharles Root CA profile, then tap Install and enter your passcode.' },
  { order: 7, description: 'Go to Settings > General > About > Certificate Trust Settings. Enable full trust for the Pharles Root CA.' },
  { order: 8, description: 'You can now capture HTTPS traffic from your iOS device. Return to this page to view captured sessions.' },
];

export const androidSteps: MobileGuideStep[] = [
  { order: 1, description: "Make sure your Android device is connected to the same Wi-Fi network as this computer." },
  { order: 2, description: 'Go to Settings > Wi-Fi (or Network & Internet > Wi-Fi), long-press your connected network and select "Modify network".' },
  { order: 3, description: 'Expand "Advanced options", set Proxy to "Manual".' },
  { order: 4, description: 'Enter the Local IP shown above as the Proxy hostname, and the Proxy Port as the Port. Tap Save.' },
  { order: 5, description: 'Scan the QR code above (or open the URL in your browser) to download the root CA certificate.' },
  { order: 6, description: 'Open the downloaded .crt file. When prompted, name it "Pharles Root CA" and install it under "VPN & app user certificate" (Android 7+) or as a trusted credential.' },
  { order: 7, description: 'Note: Starting from Android 7 (Nougat), apps do not trust user-installed certificates by default. You may need to configure network_security_config.xml in your app, or use an Android emulator with a writable system partition for full HTTPS capture.' },
  { order: 8, description: 'You can now capture traffic from your Android device. Return to this page to view captured sessions.' },
];
