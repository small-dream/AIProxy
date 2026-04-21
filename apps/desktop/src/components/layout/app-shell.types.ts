import type { ReactNode } from "react";

export type AppShellOutletContext = {
  setHeaderActions: (actions: ReactNode | null) => void;
};
