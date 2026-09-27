export const SETTINGS_SECTION_IDS = [
  "proxy",
  "upstream",
  "ssl",
  "ai",
  "appearance",
  "behavior",
  "updates",
  "about",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "proxy";

export function isSettingsSectionId(value: string | null): value is SettingsSectionId {
  return SETTINGS_SECTION_IDS.includes(value as SettingsSectionId);
}

export function readSettingsSectionParam(value: string | null): SettingsSectionId {
  return isSettingsSectionId(value) ? value : DEFAULT_SETTINGS_SECTION;
}
