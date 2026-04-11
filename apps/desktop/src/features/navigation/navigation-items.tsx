import DatasetLinkedRoundedIcon from "@mui/icons-material/DatasetLinkedRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import EditRoadRoundedIcon from "@mui/icons-material/EditRoadRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import type { ReactNode } from "react";

type NavigationItem = {
  icon: ReactNode;
  label: string;
  to: string;
};

export const navigationItems: NavigationItem[] = [
  {
    icon: <DatasetLinkedRoundedIcon />,
    label: "Sessions",
    to: "/",
  },
  {
    icon: <EditRoadRoundedIcon />,
    label: "Compose",
    to: "/compose",
  },
  {
    icon: <RuleRoundedIcon />,
    label: "Rules",
    to: "/rules",
  },
  {
    icon: <DescriptionRoundedIcon />,
    label: "Certificates",
    to: "/certificates",
  },
  {
    icon: <FolderRoundedIcon />,
    label: "Workspaces",
    to: "/workspaces",
  },
  {
    icon: <SettingsRoundedIcon />,
    label: "Settings",
    to: "/settings",
  },
];

