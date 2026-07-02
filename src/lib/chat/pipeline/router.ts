import type { Session } from "next-auth";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { getPeopleDirectory, resolvePersonName } from "@/lib/db/team-members";

export function tryFastPathRegexRoute(message: string): { answer: string; kind: "smalltalk" } | null {
  const normalized = message.trim().toLowerCase().replace(/[?!.,;]/g, "");

  const greetingRegex = /^(hi|hello|hey|greetings|good\s+morning|good\s+afternoon|good\s+evening)$/i;
  const thanksRegex = /^(thanks|thank\s+you|ty|thank\s+you\s+so\s+much)$/i;
  const byeRegex = /^(bye|goodbye|see\s+you|talk\s+later)$/i;
  const helpRegex = /^(help|what\s+can\s+you\s+do|how\s+to\s+use|how\s+do\s+i\s+use\s+this)$/i;

  if (greetingRegex.test(normalized)) {
    return {
      answer: "Hello! I am your NavGurukul Notion assistant. How can I help you today?",
      kind: "smalltalk",
    };
  }
  if (thanksRegex.test(normalized)) {
    return {
      answer: "You're very welcome! Let me know if there is anything else I can help you with.",
      kind: "smalltalk",
    };
  }
  if (byeRegex.test(normalized)) {
    return {
      answer: "Goodbye! Have a great day!",
      kind: "smalltalk",
    };
  }
  if (helpRegex.test(normalized)) {
    return {
      answer: "I can help you find pages, tasks, statuses, owners, or details in NavGurukul's Notion workspace. You can ask questions like:\n- *\"What is the status of Oscar project?\"*\n- *\"What tasks is Mahendra assigned to?\"*\n- *\"Link for Employee Onboarding Hub\"*",
      kind: "smalltalk",
    };
  }

  return null;
}

export async function resolveFirstPerson(
  message: string,
  session: Session,
): Promise<{ message: string; ambiguous?: string[]; resolvedName?: string }> {
  const hasPronoun = /\b(me|my|myself|I)\b/i.test(message);
  if (!hasPronoun) return { message };

  const fullName = session?.user?.name?.trim();
  if (!fullName) return { message };

  const { exact, candidates } = await resolvePersonName(fullName);

  if (candidates.length > 1) {
    return { message, ambiguous: candidates };
  }

  const resolvedName = exact ?? fullName.split(/\s+/)[0];
  return {
    message: message.replace(/\b(me|my|myself|I)\b/gi, resolvedName),
    resolvedName,
  };
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

export function isFollowUpQuery(message: string, history: ChatHistoryItem[]): boolean {
  if (history.length === 0) return false;

  const lower = message.toLowerCase().trim();

  if (/\b(it|this|that|they|them|he|him|she|her|his|its|their|the project|the policy|the page|the document)\b/i.test(lower)) {
    return true;
  }

  if (
    /^(only\s+)?(today|this\s+week|this\s+month|this\s+year|yesterday|tomorrow|last\s+week|last\s+month|last\s+year)('s)?\s+(task|tasks|project|projects|work|docs|pages)?$/i.test(lower) ||
    /^(for\s+)?(this\s+month|this\s+year|this\s+week|today|yesterday|last\s+year|last\s+month|20\d{2})$/i.test(lower) ||
    /^(what\s+about\s+)?(20\d{2}|this\s+year|last\s+year)$/i.test(lower) ||
    /^(any\s+)?blockers\??$/i.test(lower) ||
    /^(who\s+is\s+)?(owner|assignee|manager|lead)\??$/i.test(lower) ||
    /^(status|progress|eta)\??$/i.test(lower)
  ) {
    return true;
  }

  if (lower.split(/\s+/).length <= 4) {
    return true;
  }

  return false;
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
      /\*\*[""]?([^*"]{4,60})[""]?\*\*\s+is assigned to/i,
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
        /^(status|owner|done|backlog|unknown|open|closed|in progress|testing|blocked|not started|sync changes)$/i.test(
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
            lastPerson = candidate;
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

import { addChatMessage } from "@/lib/chat/store";
import { NextResponse } from "next/server";

export async function jsonAnswer(sessionId: string | null, answer: string, emotion?: string, signal?: AbortSignal) {
  if (signal?.aborted) {
    return new Response(null, { status: 499 });
  }
  if (sessionId) await addChatMessage(sessionId, "bot", answer, emotion);
  return NextResponse.json({ answer, emotion });
}
