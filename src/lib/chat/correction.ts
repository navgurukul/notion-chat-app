import type { ChatHistoryItem } from "@/lib/ai/openai";
import { getJsonCompletion } from "@/lib/ai/openai";
import { resolvePerson, resolveDocument } from "@/lib/query/entity-resolver";
import { reformulationCache, sqlMetadataCache } from "./cache";
import { getSessionState, updateSessionState, listChatMessages } from "./store";

const WRONG_WORDS = /\b(wrong|worng|wrng|incorrect|false|bad|error)\b/i;

export function isWrongAnswerFeedback(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return WRONG_WORDS.test(normalized);
}

export function isCorrectionMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 18) {
    return false;
  }

  // Fast-path correction indicators
  if (/^(no|wrong|incorrect|false|bad|error|it\s+was|it\s+is|i\s+meant|meant|this\s+is\s+(wrong|incorrect))\b/i.test(normalized)) {
    return true;
  }

  // Short entity swap indicators (e.g., "Sanjana not Mahendra")
  if (words.length <= 6 && (/\bnot\b/i.test(normalized) || /\binstead\s+of\b/i.test(normalized))) {
    return true;
  }

  return false;
}

export function replaceEntityInText(
  text: string,
  newEntity: string,
  oldEntityCandidate?: string,
  lastEntity?: string
): string {
  if (oldEntityCandidate) {
    const escapedTarget = oldEntityCandidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escapedTarget}\\b`, "gi");
    if (regex.test(text)) {
      return text.replace(regex, newEntity);
    }
    const index = text.toLowerCase().indexOf(oldEntityCandidate.toLowerCase());
    if (index !== -1) {
      return text.slice(0, index) + newEntity + text.slice(index + oldEntityCandidate.length);
    }
  }

  if (lastEntity) {
    const escapedTarget = lastEntity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escapedTarget}\\b`, "gi");
    if (regex.test(text)) {
      return text.replace(regex, newEntity);
    }
    const index = text.toLowerCase().indexOf(lastEntity.toLowerCase());
    if (index !== -1) {
      return text.slice(0, index) + newEntity + text.slice(index + lastEntity.length);
    }
  }

  return text;
}

function cleanEntityName(name: string): string {
  let cleaned = name.trim();
  cleaned = cleaned.replace(/^(?:no,?\s+)?(?:wait,?\s+)?(?:it's|it\s+is|it\s+was|i\s+meant|meant|related\s+to|for|about|with|be)\s+/i, "");
  cleaned = cleaned.replace(/^(?:no|wait)[,.\s]+/i, "");
  return cleaned.trim();
}

async function extractCorrectionInfoLlm(message: string): Promise<{
  isCorrection: boolean;
  isWrongAnswerFeedback: boolean;
  newEntity?: string;
  oldEntity?: string;
}> {
  try {
    const systemPrompt = `Analyze user message for entity swap or wrong answer feedback. Return JSON:
{
  "isCorrection": boolean,
  "isWrongAnswerFeedback": boolean,
  "newEntity": string | null,
  "oldEntity": string | null
}`;
    const raw = await getJsonCompletion(systemPrompt, `Message: ${message}`);
    const jsonMatch = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
    const parsed = JSON.parse(jsonMatch);
    return {
      isCorrection: Boolean(parsed.isCorrection),
      isWrongAnswerFeedback: Boolean(parsed.isWrongAnswerFeedback),
      newEntity: parsed.newEntity ? cleanEntityName(parsed.newEntity) : undefined,
      oldEntity: parsed.oldEntity ? cleanEntityName(parsed.oldEntity) : undefined,
    };
  } catch (error) {
    console.error("[Correction] LLM extraction failed:", error);
    return { isCorrection: false, isWrongAnswerFeedback: false };
  }
}

export async function detectAndHandleCorrection(
  message: string,
  history: ChatHistoryItem[],
  sessionId: string | null,
  lastEntities: { lastPerson?: string; lastProject?: string }
): Promise<{
  isCorrection: boolean;
  rewrittenMessage?: string;
  forceRefresh: boolean;
  correctedPerson?: string;
  correctedProject?: string;
  clarifyingQuestion?: string;
  isWrongAnswerRetry?: boolean;
} | null> {
  const normalized = message.trim();

  // A. Check for pending clarification first
  if (sessionId) {
    try {
      const state = await getSessionState(sessionId);
      if (state?.pendingClarification) {
        const pending = state.pendingClarification;
        const normalizedMsg = normalized.toLowerCase();
        const matchedCandidate = pending.candidates.find(c => {
          const normalizedCandidate = c.toLowerCase();
          return normalizedCandidate === normalizedMsg ||
                 normalizedCandidate.includes(normalizedMsg) ||
                 normalizedMsg.includes(normalizedCandidate) ||
                 normalizedCandidate.split(/\s+/)[0] === normalizedMsg;
        });

        if (matchedCandidate) {
          let rewrittenMessage = pending.lastUserQueryPreCorrection;
          rewrittenMessage = replaceEntityInText(
            rewrittenMessage,
            matchedCandidate,
            pending.oldEntityRaw,
            pending.oldEntityRaw
          );

          state.pendingClarification = undefined;
          if (pending.type === "person") {
            state.activePerson = {
              id: matchedCandidate,
              name: matchedCandidate,
              confidence: 1.0,
              source: "rules"
            };
            state.lastPerson = matchedCandidate;
          } else {
            state.activeProject = {
              id: matchedCandidate,
              name: matchedCandidate,
              confidence: 1.0,
              source: "rules"
            };
            state.lastProject = matchedCandidate;
          }
          state.lastRewrittenQuery = rewrittenMessage;
          state.lastUserQueryPreCorrection = rewrittenMessage;
          await updateSessionState(sessionId, state);

          return {
            isCorrection: true,
            rewrittenMessage,
            forceRefresh: true,
            correctedPerson: pending.type === "person" ? matchedCandidate : undefined,
            correctedProject: pending.type === "project" ? matchedCandidate : undefined
          };
        } else {
          state.pendingClarification = undefined;
          await updateSessionState(sessionId, state);
        }
      }
    } catch (e) {
      console.error("[Correction] Failed to handle pending clarification:", e);
    }
  }

  // B. Guard check
  if (!isCorrectionMessage(message)) {
    return null;
  }

  // Fast-path regex checks
  let isWrongFeedback = isWrongAnswerFeedback(normalized);
  let newEntityRaw: string | undefined;
  let oldEntityRaw: string | undefined;

  const notMatch = normalized.match(/(.+?)\s+(?:not|instead of)\s+(.+)/i);
  if (notMatch) {
    newEntityRaw = cleanEntityName(notMatch[1]);
    oldEntityRaw = cleanEntityName(notMatch[2]);
  } else if (!isWrongFeedback) {
    // Fast LLM JSON fallback for natural language entity swap variants
    const llmInfo = await extractCorrectionInfoLlm(message);
    if (llmInfo.isCorrection) {
      isWrongFeedback = llmInfo.isWrongAnswerFeedback;
      newEntityRaw = llmInfo.newEntity;
      oldEntityRaw = llmInfo.oldEntity;
    }
  }

  const isCorrection = isWrongFeedback || Boolean(newEntityRaw);
  if (!isCorrection) {
    return null;
  }

  // Clear caches for fresh retrieval
  reformulationCache.clear();
  sqlMetadataCache.clear();

  // Load history from DB if empty
  let resolvedHistory = [...history];
  if (resolvedHistory.length === 0 && sessionId) {
    try {
      const dbMessages = await listChatMessages(sessionId);
      resolvedHistory = dbMessages.map(m => ({
        role: m.role === "bot" ? "bot" : "user",
        content: m.content
      }));
    } catch (e) {
      console.error("[Correction] Failed to list chat messages from DB:", e);
    }
  }

  if (isWrongFeedback) {
    let rewrittenMessage: string | undefined;
    if (sessionId) {
      try {
        const state = await getSessionState(sessionId);
        if (state?.lastUserQueryPreCorrection) {
          rewrittenMessage = state.lastUserQueryPreCorrection;
        }
      } catch (e) {
        console.error("[Correction] Failed to load session state for wrong feedback:", e);
      }
    }

    if (!rewrittenMessage) {
      const userMessages = resolvedHistory.filter(item => item.role === "user");
      let targetUserMessage: ChatHistoryItem | undefined;
      for (let i = userMessages.length - 1; i >= 0; i--) {
        const uMsg = userMessages[i];
        if (uMsg.content.trim().toLowerCase() === message.trim().toLowerCase()) continue;
        if (isCorrectionMessage(uMsg.content)) continue;
        targetUserMessage = uMsg;
        break;
      }
      if (targetUserMessage) {
        rewrittenMessage = targetUserMessage.content;
      }
    }

    return {
      isCorrection,
      rewrittenMessage,
      forceRefresh: true,
      isWrongAnswerRetry: true
    };
  }

  // Find target user message to rewrite for entity swap
  let rewrittenMessage: string | undefined;
  if (sessionId) {
    try {
      const state = await getSessionState(sessionId);
      if (state?.lastUserQueryPreCorrection) {
        rewrittenMessage = state.lastUserQueryPreCorrection;
      }
    } catch (e) {
      console.error("[Correction] Failed to load session state for entity swap query:", e);
    }
  }

  let targetUserMessage: ChatHistoryItem | undefined;
  const userMessages = resolvedHistory.filter(item => item.role === "user");
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const uMsg = userMessages[i];
    if (uMsg.content.trim().toLowerCase() === message.trim().toLowerCase()) continue;
    if (isCorrectionMessage(uMsg.content)) continue;
    targetUserMessage = uMsg;
    break;
  }

  if (!rewrittenMessage) {
    if (!targetUserMessage) {
      return { isCorrection, forceRefresh: true };
    }
    rewrittenMessage = targetUserMessage.content;
  }

  let correctedPerson: string | undefined;
  let correctedProject: string | undefined;

  if (newEntityRaw) {
    // 1. Resolve to Person
    const resolvedPerson = await resolvePerson(newEntityRaw);
    if (resolvedPerson.ambiguous && resolvedPerson.candidates.length > 0) {
      const formatCandidates = (candidates: string[]) => {
        if (candidates.length === 1) return candidates[0];
        if (candidates.length === 2) return `${candidates[0]} or ${candidates[1]}`;
        return `${candidates.slice(0, -1).join(", ")}, or ${candidates[candidates.length - 1]}`;
      };
      const clarifyingQuestion = `Do you mean ${formatCandidates(resolvedPerson.candidates)}?`;

      if (sessionId) {
        try {
          const state = (await getSessionState(sessionId)) || {};
          state.pendingClarification = {
            type: "person",
            candidates: resolvedPerson.candidates,
            lastUserQueryPreCorrection: rewrittenMessage,
            oldEntityRaw: oldEntityRaw || lastEntities.lastPerson
          };
          await updateSessionState(sessionId, state);
        } catch (e) {
          console.error("[Correction] Failed to save pendingClarification in DB:", e);
        }
      }

      return {
        isCorrection: true,
        clarifyingQuestion,
        forceRefresh: true
      };
    }

    if (resolvedPerson.value || resolvedPerson.candidates.length > 0) {
      const personValue = resolvedPerson.value || resolvedPerson.candidates[0];
      correctedPerson = personValue;

      rewrittenMessage = replaceEntityInText(rewrittenMessage, personValue, oldEntityRaw || lastEntities.lastPerson, lastEntities.lastPerson);

      if (sessionId) {
        try {
          const state = (await getSessionState(sessionId)) || {};
          state.activePerson = {
            id: personValue,
            name: personValue,
            confidence: 1.0,
            source: "rules"
          };
          state.lastPerson = personValue;
          state.lastRewrittenQuery = rewrittenMessage;
          state.lastUserQueryPreCorrection = rewrittenMessage;
          await updateSessionState(sessionId, state);
        } catch (e) {
          console.error("[Correction] Failed to update session state in DB:", e);
        }
      }
    } else {
      // 2. Resolve to Document/Project
      const resolvedDoc = await resolveDocument(newEntityRaw);
      if (resolvedDoc.value) {
        correctedProject = resolvedDoc.value;

        rewrittenMessage = replaceEntityInText(rewrittenMessage, resolvedDoc.value, oldEntityRaw || lastEntities.lastProject, lastEntities.lastProject);

        if (sessionId) {
          try {
            const state = (await getSessionState(sessionId)) || {};
            state.activeProject = {
              id: resolvedDoc.value,
              name: resolvedDoc.value,
              confidence: 1.0,
              source: "rules"
            };
            state.lastProject = resolvedDoc.value;
            state.lastRewrittenQuery = rewrittenMessage;
            state.lastUserQueryPreCorrection = rewrittenMessage;
            await updateSessionState(sessionId, state);
          } catch (e) {
            console.error("[Correction] Failed to update session state in DB:", e);
          }
        }
      }
    }
  }

  if (correctedPerson) {
    const thirdPersonRegex = /\b(he|him|his|she|her|hers|they|them|their)\b/i;
    if (thirdPersonRegex.test(rewrittenMessage)) {
      rewrittenMessage = rewrittenMessage.replace(thirdPersonRegex, correctedPerson);
    }
  }

  if (!isWrongFeedback && !correctedPerson && !correctedProject) {
    return null;
  }

  return {
    isCorrection,
    rewrittenMessage,
    forceRefresh: true,
    correctedPerson,
    correctedProject
  };
}
