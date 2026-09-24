import { getJsonCompletion } from "@/lib/ai/openai";

/**
 * Gate 1: Corrective RAG (CRAG) Retrieval Relevance Grader
 * Assesses whether the retrieved document context is relevant to the user question.
 * Returns true if relevant ("yes"), false if irrelevant ("no").
 */
export async function gradeRetrieval(question: string, documentText: string): Promise<boolean> {
  if (!documentText.trim()) return false;

  const systemPrompt = `You are a grader assessing the relevance of a retrieved document to a user question.
Respond ONLY with a JSON object with a single key 'relevance' and a value of 'yes' or 'no'.`;

  const prompt = `User question: ${question}

Retrieved document:
${documentText.slice(0, 1500)}`;

  try {
    const raw = await getJsonCompletion(systemPrompt, prompt);
    const parsed = JSON.parse(raw);
    return parsed?.relevance?.toLowerCase() === "yes";
  } catch (error) {
    console.warn("[CRAG Evaluator] gradeRetrieval failed, falling back to true:", error);
    return true; // Fallback gracefully on error so pipeline is not blocked
  }
}

/**
 * Gate 2: Self-RAG Answer Groundedness Evaluator
 * Assesses whether the generated answer is strictly grounded in the provided document context.
 * Returns true if grounded ("yes"), false if hallucinated ("no").
 */
export async function reflectOnAnswer(answer: string, documentText: string): Promise<boolean> {
  if (!answer.trim() || !documentText.trim()) return true;

  const systemPrompt = `You are an evaluator checking if a generated answer is grounded in the provided documents.
Does the answer only contain information present in the documents?
Respond ONLY with a JSON object with a single key 'groundedness' and a value of 'yes' or 'no'.`;

  const prompt = `Documents:
${documentText.slice(0, 2000)}

Answer:
${answer}`;

  try {
    const raw = await getJsonCompletion(systemPrompt, prompt);
    const parsed = JSON.parse(raw);
    return parsed?.groundedness?.toLowerCase() === "yes";
  } catch (error) {
    console.warn("[Self-RAG Evaluator] reflectOnAnswer failed, falling back to true:", error);
    return true; // Fallback gracefully on error
  }
}
