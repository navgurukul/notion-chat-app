import { getJsonCompletion, type ChatHistoryItem } from "@/lib/ai";

export type EmotionAnalysis = {
  emotion: "neutral" | "happy" | "funny" | "sad" | "angry" | "frustrated" | "curious";
  isFunny: boolean;
  explanation: string;
};

export async function analyzeUserEmotion(
  message: string,
  history: ChatHistoryItem[] = [],
): Promise<EmotionAnalysis> {
  const fallback: EmotionAnalysis = {
    emotion: "neutral",
    isFunny: false,
    explanation: "Fallback default due to classification failure.",
  };

  try {
    const systemPrompt = `
You are an expert conversational psychology agent. Analyze the user's latest message (and optionally the recent chat history) to determine the user's dominant emotion/mood and check if they are trying to be funny, playful, witty, or sarcastic.

You MUST choose the dominant emotion from one of these exact categories:
1. "neutral" (professional, standard, direct query)
2. "happy" (excited, positive, warm, encouraging, celebratory)
3. "funny" (witty, joking, sarcastic, playful, telling a joke)
4. "sad" (disappointed, down, sad, vulnerable)
5. "angry" (upset, rude, passive-aggressive, angry)
6. "frustrated" (annoyed, stuck, complaining about issues/bugs/speed)
7. "curious" (highly inquisitive, asking "why" or "how" deeply, seeking detailed explanations)

If the user is trying to be funny, playful, witty, or sarcastic, set "isFunny" to true. Note: if "isFunny" is true, the emotion should also be "funny".

Respond ONLY with a JSON object in this format:
{
  "emotion": "neutral" | "happy" | "funny" | "sad" | "angry" | "frustrated" | "curious",
  "isFunny": boolean,
  "explanation": "a brief 1-sentence explanation"
}
    `.trim();

    const historyText = history
      .slice(-4)
      .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
      .join("\n");

    const prompt = `
Chat History:
${historyText || "None"}

Latest User Message:
"${message}"
    `.trim();

    // Call JSON completion with a timeout of 1.5 seconds to avoid slowing down the response
    const analysisPromise = getJsonCompletion(systemPrompt, prompt);
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500));

    const result = await Promise.race([analysisPromise, timeoutPromise]);

    if (!result) {
      console.warn("[emotion] analysis timed out, falling back to neutral");
      return fallback;
    }

    const parsed = JSON.parse(result) as EmotionAnalysis;
    if (
      parsed &&
      typeof parsed === "object" &&
      ["neutral", "happy", "funny", "sad", "angry", "frustrated", "curious"].includes(parsed.emotion) &&
      typeof parsed.isFunny === "boolean"
    ) {
      if (parsed.isFunny) {
        parsed.emotion = "funny";
      }
      return parsed;
    }

    return fallback;
  } catch (error) {
    console.error("[emotion] failed to analyze emotion:", error);
    return fallback;
  }
}
