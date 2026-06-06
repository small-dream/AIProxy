import { AppError } from "./common";

export type AppBuildInfo = {
  version: string;
  buildNumber: string;
  versionIdentifier: string;
  commitHash: string;
};

export function isAppBuildInfo(value: unknown): value is AppBuildInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AppBuildInfo>;

  return (
    typeof candidate.version === "string" &&
    typeof candidate.buildNumber === "string" &&
    typeof candidate.versionIdentifier === "string" &&
    typeof candidate.commitHash === "string"
  );
}

export function parseAppBuildInfo(value: unknown): AppBuildInfo {
  if (isAppBuildInfo(value)) {
    return value;
  }

  throw {
    code: "INVALID_APP_BUILD_INFO",
    message: "The app build info payload does not match the shared contract.",
    details: { payload: value },
  } satisfies AppError;
}
