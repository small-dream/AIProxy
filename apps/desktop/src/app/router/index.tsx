import { CircularProgress, Stack } from "@mui/material";
import { Suspense, lazy, type ComponentType } from "react";
import { createHashRouter, RouterProvider } from "react-router-dom";

import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { AppShell } from "@/components/layout/AppShell";

const SessionsPage = lazy(async () => ({
  default: (await import("@/pages/sessions")).SessionsPage,
}));
const ComposePage = lazy(async () => ({
  default: (await import("@/pages/compose")).ComposePage,
}));
const CollectionsPage = lazy(async () => ({
  default: (await import("@/pages/collections")).CollectionsPage,
}));
const ComparePage = lazy(async () => ({
  default: (await import("@/pages/compare")).ComparePage,
}));
const RulesPage = lazy(async () => ({
  default: (await import("@/pages/rules")).RulesPage,
}));
const ThrottlingPage = lazy(async () => ({
  default: (await import("@/pages/throttling")).ThrottlingPage,
}));
const InsightsPage = lazy(async () => ({
  default: (await import("@/pages/insights")).InsightsPage,
}));
const CertificatesPage = lazy(async () => ({
  default: (await import("@/pages/certificates")).CertificatesPage,
}));
const SettingsPage = lazy(async () => ({
  default: (await import("@/pages/settings")).SettingsPage,
}));

function LazyRouteFallback() {
  return (
    <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 240, width: "100%" }}>
      <CircularProgress size={24} />
    </Stack>
  );
}

function renderLazyRoute(Component: ComponentType) {
  return (
    <ErrorBoundary fallbackTitle="Page Error">
      <Suspense fallback={<LazyRouteFallback />}>
        <Component />
      </Suspense>
    </ErrorBoundary>
  );
}

const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      {
        index: true,
        element: renderLazyRoute(SessionsPage),
      },
      {
        path: "insights",
        element: renderLazyRoute(InsightsPage),
      },
      {
        path: "compose",
        element: renderLazyRoute(ComposePage),
      },
      {
        path: "collections",
        element: renderLazyRoute(CollectionsPage),
      },
      {
        path: "compare",
        element: renderLazyRoute(ComparePage),
      },
      {
        path: "rules",
        element: renderLazyRoute(RulesPage),
      },
      {
        path: "throttling",
        element: renderLazyRoute(ThrottlingPage),
      },
      {
        path: "certificates",
        element: renderLazyRoute(CertificatesPage),
      },
      {
        path: "settings",
        element: renderLazyRoute(SettingsPage),
      },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
