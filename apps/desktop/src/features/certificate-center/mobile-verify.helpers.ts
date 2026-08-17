// Pure state machine for the mobile traffic verification card. Mobile capture
// is the step users get stuck on most (wrong Wi-Fi, wrong IP, untrusted cert),
// so the setup page runs a baseline check: snapshot the session count, then
// watch live events until a NEW session arrives from the phone.
export type MobileVerifyState = "idle" | "listening" | "success" | "timeout";

export type MobileVerifyComputeInput = {
  // Whether a verification run is armed (baseline captured).
  armed: boolean;
  baselineCount: number;
  currentCount: number;
  baselineStartedAtMs: number | null;
  nowMs: number;
  timeoutMs: number;
};

export function computeMobileVerifyState(input: MobileVerifyComputeInput): MobileVerifyState {
  const { armed, baselineCount, currentCount, baselineStartedAtMs, nowMs, timeoutMs } = input;
  if (!armed) {
    return "idle";
  }
  // Success beats timeout: a session arriving in the final tick still counts.
  if (currentCount > baselineCount) {
    return "success";
  }
  if (baselineStartedAtMs !== null && nowMs - baselineStartedAtMs >= timeoutMs) {
    return "timeout";
  }
  return "listening";
}
