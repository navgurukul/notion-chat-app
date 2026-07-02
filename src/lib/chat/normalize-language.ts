import { GoogleGenerativeAI } from "@google/generative-ai";
import { normalizationCache } from "./cache";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const SYSTEM_PROMPT = `You are a query normalizer. The user may have poor English grammar or spelling.
Your job: rewrite their message in clear, standard English while PRESERVING the exact intent and meaning.

Rules:
- Fix spelling mistakes and grammar errors
- Do NOT change meaning, add assumptions, or rephrase intent
- Keep first-person pronouns (me, my, I) as-is — they are handled separately
- Keep names, titles, and proper nouns exactly as written
- If the message is already clear, return it unchanged
- Return ONLY the rewritten message — no explanation, no quotes`;

export async function normalizeLanguage(message: string): Promise<string> {
  // Skip normalization for very short or already clean messages
  if (message.length < 8) return message;

  const cacheKey = message.trim().toLowerCase();
  const cached = normalizationCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: SYSTEM_PROMPT,
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: {
        temperature: 0,       // deterministic — no creativity needed
        maxOutputTokens: 256, // queries are short
      },
    });

    const normalized = result.response.text().trim();

    // Safety check: if AI returns something wildly different in length, skip it
    if (normalized && normalized.length < message.length * 3) {
      normalizationCache.set(cacheKey, normalized);
      return normalized;
    }

    normalizationCache.set(cacheKey, message);
    return message;
  } catch {
    // Never block the pipeline — fall back to original
    normalizationCache.set(cacheKey, message);
    return message;
  }
}