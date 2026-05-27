export type QueryKind =
  | "owner_list"
  | "owner_of"
  | "created_by_list"
  | "created_by_of"
  | "assigned_list"
  | "assigned_to_of"
  | "worked_on_list"
  | "project_manager_of"
  | "topic_list"
  | "type_of"
  | "status_of"
  | "activity_summary"
  | "team_activity"
  | "team_roster"
  | "blocker_list"
  | "project_eta"
  | "page_about"
  | "project_summary"
  | "compare_pages"
  | "risks_for"
  | "onboarding_tasks"
  | "semantic";

export type QuerySource = "regex" | "llm" | "merged";

export type ParsedQuery = {
  kind: QueryKind;
  personName?: string;
  docTitle?: string;
  compareTitleB?: string;
  year?: number;
  /** 0–1 routing confidence for observability and fallback decisions */
  confidence: number;
  source: QuerySource;
  raw: string;
};

export type ClassifiedIntent = {
  intent: QueryKind;
  personName?: string | null;
  docTitle?: string | null;
  compareTitleB?: string | null;
  year?: number | null;
  confidence: number;
};
