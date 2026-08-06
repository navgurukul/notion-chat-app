/** Row shape for `notion_pages` SQL queries. */
export type NotionPageRow = {
  id: string;
  title: string | null;
  url: string | null;
  owner: string | null;
  created_by: string | null;
  last_edited_by: string | null;
  doc_type: string | null;
  status: string | null;
  content?: string | null;
  match_source?: string | null;
  notion_edited_at?: string | null;
  activity_role?: string | null;
};

export type ActivityRow = NotionPageRow & {
  notion_edited_at: string | null;
  activity_role: string | null;
  role_rank: number;
  status_rank: number;
};

export type WorkedOnRow = NotionPageRow & {
  notion_edited_at?: string | null;
  match_source?: string | null;
};
