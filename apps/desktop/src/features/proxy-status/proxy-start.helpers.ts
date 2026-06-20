import { coerceAppError } from "@aiproxy/shared-types";

/**
 * Checks whether an error indicates that the proxy port is already in use.
 * Matches the Rust `PORT_IN_USE` code as well as the OS-level bind message as
 * a defensive fallback.
 */
export function isPortInUseError(error: unknown) {
  const normalizedError = coerceAppError(error);
  const normalizedMessage = normalizedError.message.toLowerCase();

  return (
    normalizedError.code === "PORT_IN_USE" ||
    normalizedMessage.includes("already in use") ||
    normalizedMessage.includes("address already in use")
  );
}

/**
 * Reads the offending port from a start-proxy error, falling back to the
 * requested port when the backend didn't include `details.port`. Always returns
 * a number so callers can feed it straight into i18n interpolation.
 */
export function readPortFromError(error: unknown, fallback: number): number {
  const appError = coerceAppError(error);
  const port = appError.details?.port;

  return typeof port === "number" ? port : fallback;
}

/**
 * Runs `attempt` and retries it while it fails with a port-in-use error. Used
 * after killing a port's occupant: SIGKILL is asynchronous, so the listener
 * socket may not be reaped the instant the kill command returns, and the
 * immediate re-bind can race the kernel. Non-port errors propagate at once.
 * `sleep` is injectable for testing.
 */
export async function retryWhilePortInUse<T>(
  attempt: () => Promise<T>,
  maxAttempts = 5,
  delayMs = 300,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (attemptNumber < maxAttempts && isPortInUseError(error)) {
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the final iteration either returns or re-throws.
  throw new Error("retryWhilePortInUse exhausted all attempts");
}
