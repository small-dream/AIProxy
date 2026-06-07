import { CssBaseline } from "@mui/material";

import { ErrorBoundary } from "@/components/shared/ErrorBoundary";

import { AppProviders } from "./providers/AppProviders";
import { AppRouter } from "./router";

export function App() {
  return (
    <AppProviders>
      <CssBaseline enableColorScheme />
      <ErrorBoundary>
        <AppRouter />
      </ErrorBoundary>
    </AppProviders>
  );
}
