import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, AlertTitle, Button, Box, Stack } from "@mui/material";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
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
          <Alert
            severity="error"
            action={
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={this.handleRetry}>
                  Try again
                </Button>
                <Button size="small" color="inherit" onClick={this.handleFullReload}>
                  Reload app
                </Button>
              </Stack>
            }
          >
            <AlertTitle>{this.props.fallbackTitle ?? "Something went wrong"}</AlertTitle>
            {this.state.error?.message}
          </Alert>
        </Box>
      );
    }
    return this.props.children;
  }
}
