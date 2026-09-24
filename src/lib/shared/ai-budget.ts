const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_USER_DAILY_LIMIT = 50;
const DEFAULT_GLOBAL_DAILY_LIMIT = 500;

type BudgetWindow = {
  count: number;
  resetAt: number;
};

const userGenerationWindows = new Map<string, BudgetWindow>();
let globalGenerationWindow: BudgetWindow = { count: 0, resetAt: 0 };

function readLimit(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getOrResetWindow(windowState: BudgetWindow, now: number): BudgetWindow {
  if (now > windowState.resetAt) {
    return { count: 0, resetAt: now + DAY_WINDOW_MS };
  }
  return windowState;
}

export type GenerationBudgetResult = {
  allowed: boolean;
  reason?: "user_budget_exceeded" | "global_budget_exceeded";
  userCount: number;
  userLimit: number;
  globalCount: number;
  globalLimit: number;
  resetAt: number;
};

/**
 * Counts only expensive LLM generations, not SQL or retrieval.
 * This is the cheap-path gate for cost-aware routing.
 */
export function checkLlmGenerationBudget(userKey: string): GenerationBudgetResult {
  const now = Date.now();
  const userLimit = readLimit("MAX_LLM_GENERATIONS_PER_USER_PER_DAY", DEFAULT_USER_DAILY_LIMIT);
  const globalLimit = readLimit("MAX_LLM_GENERATIONS_PER_APP_PER_DAY", DEFAULT_GLOBAL_DAILY_LIMIT);

  const currentUserWindow = getOrResetWindow(
    userGenerationWindows.get(userKey) ?? { count: 0, resetAt: 0 },
    now,
  );
  const currentGlobalWindow = getOrResetWindow(globalGenerationWindow, now);

  if (currentUserWindow.count >= userLimit) {
    userGenerationWindows.set(userKey, currentUserWindow);
    globalGenerationWindow = currentGlobalWindow;
    return {
      allowed: false,
      reason: "user_budget_exceeded",
      userCount: currentUserWindow.count,
      userLimit,
      globalCount: currentGlobalWindow.count,
      globalLimit,
      resetAt: currentUserWindow.resetAt,
    };
  }

  if (currentGlobalWindow.count >= globalLimit) {
    userGenerationWindows.set(userKey, currentUserWindow);
    globalGenerationWindow = currentGlobalWindow;
    return {
      allowed: false,
      reason: "global_budget_exceeded",
      userCount: currentUserWindow.count,
      userLimit,
      globalCount: currentGlobalWindow.count,
      globalLimit,
      resetAt: currentGlobalWindow.resetAt,
    };
  }

  const nextUserWindow = { ...currentUserWindow, count: currentUserWindow.count + 1 };
  const nextGlobalWindow = { ...currentGlobalWindow, count: currentGlobalWindow.count + 1 };
  userGenerationWindows.set(userKey, nextUserWindow);
  globalGenerationWindow = nextGlobalWindow;

  return {
    allowed: true,
    userCount: nextUserWindow.count,
    userLimit,
    globalCount: nextGlobalWindow.count,
    globalLimit,
    resetAt: Math.min(nextUserWindow.resetAt, nextGlobalWindow.resetAt),
  };
}