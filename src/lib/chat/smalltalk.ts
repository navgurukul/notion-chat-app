import type { ChatHistoryItem } from "@/lib/ai/openai";
import { getPeopleDirectory, resolvePersonName } from "@/lib/db";
import { addChatMessage } from "./store";
import { NextResponse } from "next/server";

export type SmalltalkType = "greeting" | "thanks" | "bye" | "help" | "identity" | "howAreYou";

const greetingRegex = /^(hi|hello|hey|greetings|good\s+morning|good\s+afternoon|good\s+evening)$/i;
const thanksRegex = /^(thanks|thank\s+you|ty|thank\s+you\s+so\s+much)$/i;
const byeRegex = /^(bye|goodbye|see\s+you|talk\s+later|bye\s+now)$/i;
const helpRegex = /^(help|what\s+can\s+you\s+do|how\s+to\s+use|how\s+do\s+i\s+use\s+this)$/i;
const botIdentityRegex = /^(who\s+are\s+you|what\s+is\s+your\s+name|who\s+created\s+you|are\s+you\s+a\s+bot|what\s+are\s+you)$/i;
const howAreYouRegex = /^(how\s+are\s+you|how\s+is\s+it\s+going|how's\s+it\s+going|whats\s+up|what's\s+up)$/i;

export function detectSmalltalkType(message: string): SmalltalkType | null {
  const normalized = message.trim().toLowerCase().replace(/[?!.,;]/g, "");

  if (greetingRegex.test(normalized)) return "greeting";
  if (thanksRegex.test(normalized)) return "thanks";
  if (byeRegex.test(normalized)) return "bye";
  if (helpRegex.test(normalized)) return "help";
  if (botIdentityRegex.test(normalized)) return "identity";
  if (howAreYouRegex.test(normalized)) return "howAreYou";

  return null;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const SMALLTALK_VARIATIONS: Record<SmalltalkType, string[]> = {
  greeting: [
    "Hello! I am your NavGurukul Notion assistant. How can I help you today?",
    "Hey! I’m here to help you find pages, tasks, owners, and statuses in NavGurukul’s Notion. What do you need?",
    "Hi! Want to look up a project, tasks, owners, or details in our Notion workspace?",
    "Good to see you — tell me what we should check in NavGurukul’s Notion.",
  ],
  thanks: [
    "You're very welcome! Let me know if there is anything else I can help you with.",
    "Anytime! Tell me what you’d like to check next in Notion.",
    "Glad to help — what should we look up now?",
    "Happy to help. Want the direct Notion link for anything we find?",
  ],
  bye: [
    "Goodbye! Have a great day!",
    "See you later — ping me whenever you want to look something up in Notion.",
    "Bye! Take care — and come back anytime you need project or task details.",
    "Talk later! I’ll be here when you’re ready.",
  ],
  help: [
    "I can help you find pages, tasks, statuses, owners, or details in NavGurukul's Notion workspace. You can ask questions like:\n- *\"What is the status of Oscar project?\"*\n- *\"What tasks is Mahendra assigned to?\"*\n- *\"Link for Employee Onboarding Hub\"*",
    "I can help you search our Notion for projects, owners, tasks, and statuses. Try:\n- *\"Who owns the DataPivots project?\"*\n- *\"Tasks assigned to Tamanna\"*\n- *\"Project ETA for Oscar\"*",
    "Need something from NavGurukul’s Notion? I can fetch links and summarize details. Examples:\n- *\"Link for Employee Onboarding Hub\"*\n- *\"Status of Oscar project\"*\n- *\"Who’s working on Zuvy?\"*",
  ],
  identity: [
    "I am your NavGurukul Notion assistant, built to help you navigate and query workplace documentation, projects, and team directories.",
    "I’m the NavGurukul Notion assistant — ask me about projects, task assignments, owners, and status updates.",
    "I help you search our synced Notion: pages, tasks, people, owners, and project info.",
  ],
  howAreYou: [
    "I'm doing great, thank you! I'm ready to help you search NavGurukul's Notion workspace. What can I find for you today?",
    "Doing well — thanks! Tell me what you’d like to look up in our Notion.",
    "I’m good! Ready whenever you are — want project status, task assignments, or a specific page link?",
    "All set. What should we check in NavGurukul’s Notion today?",
  ],
};

const SMALLTALK_NAME_VARIATIONS: Partial<Record<SmalltalkType, string[]>> = {
  greeting: [
    "Hi {name}! I’m your NavGurukul Notion assistant. What can I help you with today?",
    "Hey {name}! I’m here to help you find pages, tasks, and status updates in Notion. What do you need?",
  ],
  thanks: [
    "Thanks, {name}! You’re very welcome — tell me what we should look up next.",
    "Anytime, {name}! Want to pull a project status or a page link from Notion?",
  ],
  bye: [
    "Bye {name}! Have a great day — ping me anytime you need Notion details.",
    "Talk later, {name}! I’ll be here when you’re ready.",
  ],
  help: [
    "Sure {name}! I can help you find pages, tasks, owners, or statuses in NavGurukul’s Notion. What should we look up?",
  ],
  identity: [
    "Nice to meet you, {name}! I’m the NavGurukul Notion assistant — I can help with pages, tasks, owners, and project info.",
  ],
  howAreYou: [
    "Hi {name}! I’m doing great — thanks. What can I find for you in NavGurukul’s Notion today?",
  ],
};

export function tryFastPathRegexRoute(
  message: string,
  userName?: string,
): { answer: string; kind: "smalltalk" } | null {
  const smalltalkType = detectSmalltalkType(message);
  if (!smalltalkType) return null;

  const base = SMALLTALK_VARIATIONS[smalltalkType];
  const named = SMALLTALK_NAME_VARIATIONS[smalltalkType];

  if (named?.length && userName?.trim()) {
    const tpl = pickRandom(named);
    return {
      answer: tpl.replace(/\{name\}/g, userName.trim()),
      kind: "smalltalk",
    };
  }

  return {
    answer: pickRandom(base),
    kind: "smalltalk",
  };
}

export function isAmbiguousQuery(message: string, history: ChatHistoryItem[] = []): boolean {
  if (history && history.length > 0) {
    return false;
  }

  const normalized = message.trim().toLowerCase().replace(/[?!.,;]/g, "");
  const words = normalized.split(/\s+/).filter(Boolean);

  // 1. Single word queries
  if (words.length === 1) {
    return true;
  }

  // 2. Short vague phrases with no specific entity
  const vaguePatterns = [
    /^(show|list|get|what\s+is|who\s+is)?\s*(owner|manager|pm|lead|status|eta|creator|type)$/i,
    /^who\s+owns?\s+(it|this|that|them)$/i,
    /^(what\s+about|tell\s+me\s+more\s+about|show\s+details\s+for)\s+(it|this|that)$/i,
    /^is\s+there\s+any\s+task$/i,
  ];

  if (vaguePatterns.some(pattern => pattern.test(normalized))) {
    return true;
  }

  return false;
}

export async function findPersonInText(text: string): Promise<string | null> {
  try {
    const dir = await getPeopleDirectory();
    const lowerText = text.toLowerCase();

    const sortedDir = [...dir].sort((a, b) => b.normalized.length - a.normalized.length);

    for (const person of sortedDir) {
      const escaped = person.normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(lowerText)) {
        return person.name;
      }
    }

    for (const person of sortedDir) {
      const firstName = person.normalized.split(/\s+/)[0];
      if (firstName && firstName.length >= 3) {
        const escaped = firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\b${escaped}\\b`, "i");
        if (regex.test(lowerText)) {
          return person.name;
        }
      }
    }
  } catch (error) {
    console.warn("[chat] findPersonInText failed:", error);
  }
  return null;
}

export async function extractLastEntityFromHistory(history: ChatHistoryItem[]): Promise<{
  lastProject?: string;
  lastPerson?: string;
}> {
  const recentHistory = [...history].reverse().slice(0, 6);

  let lastProject: string | undefined;
  let lastPerson: string | undefined;

  for (const item of recentHistory) {
    const content = item.content;

    const boldMatches = [...content.matchAll(/\*\*([^*]{2,60})\*\*/g)];
    const backtickMatches = [...content.matchAll(/`([^`]{2,60})`/g)];
    const linkMatches = [...content.matchAll(/\[([^\]]{2,80})\]\([^)]+\)/g)];

    const titlePrefixMatch = content.match(/^Title:\s*(.+)$/m);
    const titlePrefixCandidate = titlePrefixMatch?.[1] ?? null;

    const allCandidateSources: Array<[RegExpMatchArray | null, string]> = [];
    for (const m of boldMatches) allCandidateSources.push([m, m[1]]);
    for (const m of backtickMatches) allCandidateSources.push([m, m[1]]);
    for (const m of linkMatches) allCandidateSources.push([m, m[1]]);
    if (titlePrefixCandidate) allCandidateSources.push([null, titlePrefixCandidate]);

    const assignedToMatch = content.match(
      /\*\*[\""]?([^*\"]{4,60})[\""]?\*\*\s+is assigned to/i,
    );
    if (assignedToMatch?.[1] && !lastProject) {
      lastProject = assignedToMatch[1].trim();
    }

    const aboutMatch = content.match(
      /(?:about|objective of|overview of|summary of)\s+(?:the\s+)?\*\*([^*]{4,60})\*\*/i,
    );
    if (aboutMatch?.[1] && !lastProject) {
      lastProject = aboutMatch[1].trim();
    }

    for (const [, rawCandidate] of allCandidateSources) {
      const candidate = rawCandidate.trim();
      if (!candidate) continue;

      if (
        /^(status|owner|done|backlog|unknown|open|closed|in progress|in development|testing|blocked|not started|on hold|scoping|completed|prod ready|sync changes)$/i.test(
          candidate,
        )
      )
        continue;
      if (candidate.split(/\s+/).length > 6) continue;
      if (candidate.length < 3) continue;

      const idx = content.indexOf(rawCandidate);
      const surrounding = content.slice(
        Math.max(0, (idx ?? 0) - 50),
        Math.min(content.length, (idx ?? 0) + 100),
      );

      if (
        /project|status|working|owner|summary|about|assigned|scope|objective|maintaining|backlog|development/i.test(
          surrounding,
        )
      ) {
        if (!lastProject) {
          lastProject = candidate;
        }
      }
    }

    for (const [, rawCandidate] of allCandidateSources) {
      const candidate = rawCandidate.trim();
      if (!candidate) continue;

      const idx = content.indexOf(rawCandidate);
      const surrounding = content.slice(
        Math.max(0, (idx ?? 0) - 40),
        Math.min(content.length, (idx ?? 0) + 80),
      );

      if (/\b(owner|assignee|created by|assigned to|working on)\b/i.test(surrounding)) {
        if (candidate.split(/\s+/).length <= 3 && candidate.length >= 3) {
          if (!lastPerson) {
            const resolved = await resolvePersonName(candidate);
            if (resolved.exact) {
              lastPerson = resolved.exact;
            }
          }
        }
      }
    }

    if (!lastPerson) {
      const detectedPerson = await findPersonInText(content);
      if (detectedPerson) {
        lastPerson = detectedPerson;
      }
    }

    if (lastProject || lastPerson) {
      break;
    }
  }

  return { lastProject, lastPerson };
}

export async function jsonAnswer(sessionId: string | null, answer: string, emotion?: string, signal?: AbortSignal) {
  if (signal?.aborted) {
    return new Response(null, { status: 499 });
  }
  if (sessionId) {
    await addChatMessage(sessionId, "bot", answer, emotion).catch(err => console.error("[DB Write Error] Failed to save bot message:", err));
  }
  return NextResponse.json({ answer, emotion });
}
