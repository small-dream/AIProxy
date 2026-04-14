import { createHashRouter, RouterProvider } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { CertificatesPage } from "@/pages/certificates";
import { ComposePage } from "@/pages/compose";
import { RulesPage } from "@/pages/rules";
import { SessionsPage } from "@/pages/sessions";
import { SettingsPage } from "@/pages/settings";
import { ThrottlingPage } from "@/pages/throttling";

const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      {
        index: true,
        element: <SessionsPage />,
      },
      {
        path: "compose",
        element: <ComposePage />,
      },
      {
        path: "rules",
        element: <RulesPage />,
      },
      {
        path: "throttling",
        element: <ThrottlingPage />,
      },
      {
        path: "certificates",
        element: <CertificatesPage />,
      },
      {
        path: "settings",
        element: <SettingsPage />,
      },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
