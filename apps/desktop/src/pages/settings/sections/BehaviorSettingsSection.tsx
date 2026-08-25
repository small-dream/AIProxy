import { Stack, Switch } from "@mui/material";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { SectionCard } from "@/components/shared/SectionCard";
import { ensureNotificationPermission } from "@/services/notifications/system-notifications";
import { useI18n } from "@/i18n";
import { SettingsGroup, SettingsRow } from "../SettingsLayoutParts";

export function BehaviorSettingsSection() {
  const { t } = useI18n();
  const skipClearSessionsConfirm = useAppPreferencesStore(
    (state) => state.skipClearSessionsConfirm,
  );
  const setSkipClearSessionsConfirm = useAppPreferencesStore(
    (state) => state.setSkipClearSessionsConfirm,
  );
  const breakpointSystemNotifications = useAppPreferencesStore(
    (state) => state.breakpointSystemNotifications,
  );
  const setBreakpointSystemNotifications = useAppPreferencesStore(
    (state) => state.setBreakpointSystemNotifications,
  );

  return (
    <Stack spacing={2}>
      <SectionCard
        compact
        title={t("settingsPage.confirmSectionTitle")}
        description={t("settingsPage.confirmSectionDescription")}
      >
        {/* Re-enables the confirmation dialog after the user ticked "don't ask
            again" in the Clear All Sessions dialog. See UI_GUIDELINES §11.4. */}
        <SettingsGroup>
          <SettingsRow
            itemId="clear-confirmations"
            label={t("settingsPage.clearSessionsConfirmLabel")}
            description={t("settingsPage.clearSessionsConfirmDescription")}
          >
            <Switch
              size="small"
              checked={!skipClearSessionsConfirm}
              onChange={(event) => setSkipClearSessionsConfirm(!event.target.checked)}
            />
          </SettingsRow>
        </SettingsGroup>
      </SectionCard>

      <SectionCard
        compact
        title={t("settingsPage.notificationsSectionTitle")}
        description={t("settingsPage.notificationsSectionDescription")}
      >
        {/* OS-level breakpoint notifications (review §4.3). Enabling runs a
            best-effort permission request; a denial degrades silently back to
            the in-app panel + toast channel. */}
        <SettingsGroup>
          <SettingsRow
            itemId="breakpoint-notifications"
            label={t("settingsPage.breakpointNotificationsLabel")}
            description={t("settingsPage.breakpointNotificationsDescription")}
          >
            <Switch
              size="small"
              checked={breakpointSystemNotifications}
              onChange={(event) => {
                const next = event.target.checked;
                setBreakpointSystemNotifications(next);
                if (next) {
                  void ensureNotificationPermission();
                }
              }}
            />
          </SettingsRow>
        </SettingsGroup>
      </SectionCard>
    </Stack>
  );
}
