import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function getChatResponse(prompt: string, context: string) {
  try {
    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: `You are an AI assistant that answers questions based on NavGurukul's Notion documentation.
Below is the content extracted from the database:

---
${context}
---

Answer the user's question accurately using only the provided context. If the answer is not in the context, say you don't know based on the Notion data.`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    return completion.choices[0]?.message?.content || "";
  } catch (error) {
    console.error("Groq Error:", error);
    throw error;
  }
}

// Stream adapter to maintain compatible interface with chat route
async function* groqStreamAdapter(stream: AsyncIterable<any>) {
  for await (const chunk of stream) {
    const content = chunk.choices?.[0]?.delta?.content || "";
    if (content) {
      yield {
        text: () => content,
      };
    }
  }
}

export async function getChatStream(prompt: string, context: string) {
  try {
    const stream = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: `You are an AI assistant that answers questions based on NavGurukul's Notion documentation. 
Below is the content extracted from the database:

---
${context}
---

Answer the user's question accurately using only the provided context. If the answer is not in the context, say you don't know based on the Notion data.`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      stream: true,
    });

    return groqStreamAdapter(stream);
  } catch (error) {
    console.error("Groq Stream Error:", error);
    throw error;
  }
}
