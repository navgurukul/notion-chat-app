import { query } from "@/lib/db/postgres";

export const NOTION_LAST_SYNC_RUN_KEY = "notion_last_sync_run";

export async function getNotionLastSyncRun(): Promise<string | null> {
  const rows = await query<{ value: string }>(
    `
    SELECT value
    FROM sync_metadata
    WHERE key = $1
    LIMIT 1
    `,
    [NOTION_LAST_SYNC_RUN_KEY],
  );
  return rows[0]?.value ?? null;
}

export async function setNotionLastSyncRun(isoTime: string) {
  await query(
    `
    INSERT INTO sync_metadata (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    `,
    [NOTION_LAST_SYNC_RUN_KEY, isoTime],
  );
}
