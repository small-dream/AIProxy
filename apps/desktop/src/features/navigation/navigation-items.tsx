import BarChartRoundedIcon from "@mui/icons-material/BarChartRounded";
import DatasetLinkedRoundedIcon from "@mui/icons-material/DatasetLinkedRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import EditRoadRoundedIcon from "@mui/icons-material/EditRoadRounded";
import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
import FolderCopyRoundedIcon from "@mui/icons-material/FolderCopyRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
import type { ReactNode } from "react";

import type { TranslationKey } from "@/i18n";

type NavigationItem = {
  group: "manage" | "workspace";
  icon: ReactNode;
  labelKey: TranslationKey;
  to: string;
};

export const navigationItems: NavigationItem[] = [
  {
    group: "workspace",
    icon: <DatasetLinkedRoundedIcon />,
    labelKey: "navigation.sessions",
    to: "/",
  },
  {
    group: "workspace",
    icon: <BarChartRoundedIcon />,
    labelKey: "navigation.insights",
    to: "/insights",
  },
  {
    group: "workspace",
    icon: <EditRoadRoundedIcon />,
    labelKey: "navigation.compose",
    to: "/compose",
  },
  {
    group: "workspace",
    icon: <FolderCopyRoundedIcon />,
    labelKey: "navigation.collections",
    to: "/collections",
  },
  {
    group: "workspace",
    icon: <CompareArrowsRoundedIcon />,
    labelKey: "navigation.compare",
    to: "/compare",
  },
  {
    group: "workspace",
    icon: <RuleRoundedIcon />,
    labelKey: "navigation.rules",
    to: "/rules",
  },
  {
    group: "workspace",
    icon: <SpeedRoundedIcon />,
    labelKey: "navigation.throttling",
    to: "/throttling",
  },
  {
    group: "manage",
    icon: <DescriptionRoundedIcon />,
    labelKey: "navigation.certificates",
    to: "/certificates",
  },
  {
    group: "manage",
    icon: <SettingsRoundedIcon />,
    labelKey: "navigation.settings",
    to: "/settings",
  },
];
