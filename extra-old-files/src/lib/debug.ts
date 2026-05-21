const REQUIRED_ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_BUCKET_NAME",
  "AWS_KNOWLEDGE_BASE_ID",
  "AWS_DATA_SOURCE_ID",
  "NOTION_TOKEN",
  "GEMINI_API_KEY",
] as const;

export function areDebugRoutesEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_DEBUG_ROUTES === "true";
}

export function envPresence() {
  return Object.fromEntries(
    REQUIRED_ENV_KEYS.map((key) => [
      key,
      {
        present: Boolean(process.env[key]),
      },
    ]),
  );
}

export function maskIdentifier(value: string | undefined) {
  if (!value) return null;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export function getErrorDetails(error: unknown) {
  return error instanceof Error ? error.toString() : String(error);
}
