# Certificate Setup & Capture Troubleshooting

AIProxy decrypts HTTPS traffic through a local root certificate. This guide covers certificate installation on all three platforms (macOS / Windows / Linux), capturing from mobile devices and emulators, and the common reasons behind "I installed it but still can't capture anything."

> For first-time use, follow the in-app **Setup Wizard** (it auto-opens on first launch; afterwards you can reopen it from the setup checklist at the top of the **Sessions** page). It walks you through: generate the root certificate → install & trust it → start the proxy → enable the system proxy → capture your first HTTPS request.

## The goal state: `captureReady`

HTTPS capture only works when **all** of the following are true (the setup checklist disappears once they are):

1. The root certificate has been generated;
2. The root certificate is **trusted** on this machine;
3. The proxy is **running**;
4. **SSL decryption is enabled** (otherwise the proxy only forwards HTTPS without decrypting it, so no plaintext is captured);
5. Traffic is routed to AIProxy (system proxy on, or you explicitly chose manual proxy configuration).

A trusted certificate alone is not enough. Make sure SSL decryption is on, the proxy is running, and traffic is routed.

## Install & trust per platform

### macOS
1. On the **Certificates** page click **Install Certificate**, or double-click the certificate file (`aiproxy-root-ca.cer`).
2. In **Keychain Access**, add the certificate to the **System** keychain (not login).
3. Double-click the certificate → expand **Trust** → set "When using this certificate" to **Always Trust**, then close the window.
4. Enter your **administrator password** to confirm.
5. Restart your browser so the trust takes effect.

### Windows
1. Click **Install Certificate** → choose **Local Machine**.
2. Place it in the **Trusted Root Certification Authorities** store.
3. Finish the wizard and restart your browser.

### Linux
1. Copy the certificate into the system CA directory and update it:
   ```bash
   sudo cp aiproxy-root-ca.crt /usr/local/share/ca-certificates/aiproxy-root-ca.crt
   sudo update-ca-certificates
   ```
2. The directory differs by distro (Fedora/RHEL use `/etc/pki/ca-trust/source/anchors/` + `sudo update-ca-trust`).
3. **Automatic system-proxy configuration only supports GNOME and KDE**; on other desktop environments, set the HTTP/HTTPS proxy manually in your browser/system to point at AIProxy.

## Common failure reference

### <a id="port-in-use"></a>Proxy port already in use
- **Symptom**: starting the proxy fails with a port-in-use error (`PORT_IN_USE` / "address already in use").
- **Cause**: another process (often a previous AIProxy that didn't quit, or another capture tool) is using the same port.
- **Fix**: stop the process holding the port; or change the port in proxy settings (default 8888) and retry.

### <a id="cert-not-found"></a>Certificate not found
- **Symptom**: install/diagnose reports "No certificate found".
- **Cause**: the root certificate has not been generated yet.
- **Fix**: **generate the root certificate** first (on the **Certificates** page or in the setup wizard), then install it.

### <a id="proxy-not-running"></a>Proxy not running
- **Symptom**: enabling the system proxy or configuring a device reports "Proxy not running".
- **Cause**: the proxy isn't started (it usually auto-starts, but a port conflict can block the auto-start).
- **Fix**: start the proxy from the status bar and confirm the port is free before enabling the system proxy / configuring a device.

### <a id="permission-denied"></a>Permission denied
- **Symptom**: macOS keychain / Windows install / Linux `sudo` reports a permission failure.
- **Cause**: administrator permission was not granted or keychain access was denied.
- **Fix**: re-run and enter the admin password / authorize the keychain; on Linux make sure you used `sudo`.

### <a id="installer-failed"></a>System installer won't open
- **Symptom**: clicking **Install Certificate** doesn't open the system installer, or it errors.
- **Cause**: the system certificate installer association is broken.
- **Fix**: on the **Certificates** page, locate the certificate file manually and double-click to install; or follow the per-platform manual steps above.

### <a id="generate-failed"></a>Root certificate generation failed
- **Symptom**: generation errors (`rcgen` / disk write failure).
- **Fix**: retry; if it keeps failing, check the dev log `logs/dev/aiproxy-desktop-dev.log` for disk permission or free-space issues.

### <a id="troubleshooting"></a>Installed but still no traffic
If `captureReady` is satisfied but the **Sessions** page shows no traffic, check each of these:

1. **Browser isn't using the proxy**: confirm the system proxy is on; or point the browser manually at `127.0.0.1:8888` (or your configured port).
2. **Certificate not in effect**: go back to **Certificates** and confirm the trust status is trusted; re-trust and restart the browser if needed.
3. **Target app uses certificate pinning**: apps like DingTalk and banking apps often pin certificates and will reject the proxy. Verify the chain with a normal browser first, then deal with the pinning app.

## Mobile / emulator capture

Open the **Mobile** tab on the **Certificates** page. Mobile capture has a **preflight check**: you must first have "root certificate generated + proxy running + local LAN IP reachable" before the QR / ADB / hdc / Simulator panels unlock.

- **Android device (USB)**: enable USB debugging, then use **Android Quick Action** to push the certificate and set the system proxy in one step (requires `adb` on PATH or `ANDROID_HOME` set). Note that most Android devices still need you to confirm the install in system certificate management.
- **Android emulator**: same ADB flow; emulators usually have root, so the cert can be installed as a system certificate.
- **HarmonyOS NEXT physical device (USB)**: enable HDC debugging in developer options, then use **HarmonyOS Quick Action** to push the certificate to the device's Downloads folder (`/storage/media/100/local/files/Download/`) via `hdc` (requires `hdc` on PATH or `HDC_PATH` set, or DevEco Studio installed). Pushing is not installation or trust: manually go to **Settings → Security & Privacy → Encryption & credentials → Install from storage**, open the Downloads folder in the file picker, and pick the pushed certificate to finish the install. If the file is still not visible, download the certificate with the QR code or device browser instead. Manual installation creates a user/VPN & apps certificate, not a system root certificate; use a rooted or writable-system test device for system CA installation. HarmonyOS NEXT has no official hdc global HTTP proxy command, so configure the proxy manually in the device's Wi-Fi settings, pointing it at the computer IP and proxy port. The device and computer must be on the same Wi-Fi network.
- **HarmonyOS NEXT emulator**: hdc can detect emulator targets with `hdc list targets -v` and use the same push action, but the emulator does not need to be on the same Wi-Fi network. Configure the proxy manually in the emulator's system network settings, using a computer IP that the emulator can reach and the AIProxy port. Certificate installation still requires manual confirmation in the emulator settings. If the hdc-pushed file is not visible, open the certificate download URL in the emulator browser and install it from Downloads.
- **iOS simulator** (macOS only): use **iOS Quick Action** to install via `xcrun simctl keychain`; afterwards still manually enable full trust in the simulator's **Settings → General → About → Certificate Trust Settings**.
- **iOS device**: automatic install is not supported. Use the **Certificate download QR code**, open it in Safari on the phone to download, follow the system prompt to install the profile and enable it in **Certificate Trust Settings**; configure the proxy manually in the phone's Wi-Fi settings to point at your computer's IP:port. Same Wi-Fi network is a prerequisite.

## Diagnostics

The **Certificates** page offers **Run Diagnostics** (backed by the `diagnose_certificate_setup` command). It summarizes: whether the certificate exists / is readable / is trusted, whether `adb` is available, whether `hdc` is available, and whether the iOS simulator toolchain is ready (macOS only), giving a conclusion and hint for each item to help pinpoint environment issues.

## FAQ

- **Is the root certificate safe?** It is generated on your machine and the private key never leaves it. When not in use, you can remove it and revoke trust on the **Certificates** page.
- **Do I need to reinstall after changing machines / reinstalling?** Yes. The root certificate is bound to the machine; a new machine requires regenerating and re-trusting.
- **Browser still warns after trusting?** Fully quit and restart the browser; some browsers (Firefox) have an independent certificate store and need a separate import.
