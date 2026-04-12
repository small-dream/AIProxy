import DatasetLinkedRoundedIcon from "@mui/icons-material/DatasetLinkedRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import EditRoadRoundedIcon from "@mui/icons-material/EditRoadRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import type { ReactNode } from "react";

type NavigationItem = {
  group: "manage" | "workspace";
  icon: ReactNode;
  label: string;
  to: string;
};

export const navigationItems: NavigationItem[] = [
  {
    group: "workspace",
    icon: <DatasetLinkedRoundedIcon />,
    label: "Sessions",
    to: "/",
  },
  {
    group: "workspace",
    icon: <EditRoadRoundedIcon />,
    label: "Compose",
    to: "/compose",
  },
  {
    group: "workspace",
    icon: <RuleRoundedIcon />,
    label: "Rules",
    to: "/rules",
  },
  {
    group: "manage",
    icon: <DescriptionRoundedIcon />,
    label: "Certificates",
    to: "/certificates",
  },
  {
    group: "manage",
    icon: <FolderRoundedIcon />,
    label: "Workspaces",
    to: "/workspaces",
  },
  {
    group: "manage",
    icon: <SettingsRoundedIcon />,
    label: "Settings",
    to: "/settings",
  },
];

