import { CssBaseline } from "@mui/material";

import { AppProviders } from "./providers/AppProviders";
import { AppRouter } from "./router";

export function App() {
  return (
    <AppProviders>
      <CssBaseline enableColorScheme />
      <AppRouter />
    </AppProviders>
  );
}
