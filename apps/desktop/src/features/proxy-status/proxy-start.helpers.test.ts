import { describe, expect, it, vi } from "vitest";

import { isPortInUseError, readPortFromError, retryWhilePortInUse } from "./proxy-start.helpers";

describe("isPortInUseError", () => {
  it("detects PORT_IN_USE code in a JSON error string", () => {
    const error = JSON.stringify({ code: "PORT_IN_USE", message: "Port busy" });
    expect(isPortInUseError(error)).toBe(true);
  });

  it("detects 'already in use' in the message text", () => {
    expect(isPortInUseError("Address already in use")).toBe(true);
  });

  it("detects 'address already in use' case-insensitively", () => {
    expect(isPortInUseError("ADDRESS ALREADY IN USE")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isPortInUseError("something else")).toBe(false);
  });

  it("returns false for a JSON error with a different code", () => {
    const error = JSON.stringify({ code: "INTERNAL_ERROR", message: "other" });
    expect(isPortInUseError(error)).toBe(false);
  });
});

describe("readPortFromError", () => {
  it("reads the port from details when present", () => {
    const error = JSON.stringify({
      code: "PORT_IN_USE",
      message: "Port 8888 is already in use.",
      details: { host: "127.0.0.1", port: 8888 },
    });
    expect(readPortFromError(error, 9999)).toBe(8888);
  });

  it("falls back to the requested port when details.port is missing", () => {
    const error = JSON.stringify({ code: "PORT_IN_USE", message: "Port busy" });
    expect(readPortFromError(error, 7777)).toBe(7777);
  });

  it("falls back when details.port is not a number", () => {
    const error = JSON.stringify({
      code: "PORT_IN_USE",
      message: "Port busy",
      details: { port: "not-a-number" },
    });
    expect(readPortFromError(error, 6666)).toBe(6666);
  });
});

describe("retryWhilePortInUse", () => {
  const portInUseError = () => JSON.stringify({ code: "PORT_IN_USE", message: "Port busy" });

  it("returns the result without sleeping when the first attempt succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await retryWhilePortInUse(async () => "ok", 5, 300, sleep);
    expect(result).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on port-in-use errors until success, sleeping between attempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const result = await retryWhilePortInUse(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw portInUseError();
        }
        return "ok";
      },
      5,
      300,
      sleep,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(300);
  });

  it("does not retry and rethrows immediately on non-port errors", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const attempt = vi
      .fn()
      .mockRejectedValue(JSON.stringify({ code: "INTERNAL_ERROR", message: "boom" }));
    await expect(retryWhilePortInUse(attempt, 5, 300, sleep)).rejects.toBeDefined();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts of port-in-use errors, rethrowing the last one", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const attempt = vi.fn().mockRejectedValue(portInUseError());
    await expect(retryWhilePortInUse(attempt, 3, 300, sleep)).rejects.toBeDefined();
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
