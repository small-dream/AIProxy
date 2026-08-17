import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, AlertTitle, Button, Box, Stack } from "@mui/material";

import { useI18n, type TranslationKey } from "@/i18n";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackTitleKey?: TranslationKey;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React error boundary that catches rendering errors in child components
 * and displays a fallback UI using MUI Alert.
 * Must be placed inside AppProviders so the fallback can use theme/i18n context.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // TODO: integrate with dev_logger or structured logging
    console.error("[ErrorBoundary] caught:", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  handleFullReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <Box
          sx={{
            p: 3,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ErrorBoundaryFallback
            error={this.state.error}
            fallbackTitle={this.props.fallbackTitle}
            fallbackTitleKey={this.props.fallbackTitleKey}
            onFullReload={this.handleFullReload}
            onRetry={this.handleRetry}
          />
        </Box>
      );
    }
    return this.props.children;
  }
}

function ErrorBoundaryFallback({
  error,
  fallbackTitle,
  fallbackTitleKey,
  onFullReload,
  onRetry,
}: {
  error: Error | null;
  fallbackTitle?: string | undefined;
  fallbackTitleKey?: TranslationKey | undefined;
  onFullReload: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();

  return (
    <Alert
      severity="error"
      action={
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={onRetry}>
            {t("errorBoundary.tryAgain")}
          </Button>
          <Button size="small" color="inherit" onClick={onFullReload}>
            {t("errorBoundary.reloadApp")}
          </Button>
        </Stack>
      }
    >
      <AlertTitle>
        {fallbackTitleKey ? t(fallbackTitleKey) : (fallbackTitle ?? t("errorBoundary.title"))}
      </AlertTitle>
      {error?.message}
    </Alert>
  );
}
