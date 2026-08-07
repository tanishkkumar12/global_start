import { GoogleGenAI } from "@google/genai";

export const config = {
  runtime: "edge",
};

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

async function generateStreamWithRetry(contents: any, systemInstruction: any) {
  const models = [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b"
  ];
  let lastError: any = null;

  for (const model of models) {
    let delay = 1000;
    const retries = 3;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[Gemini API Edge] Trying streaming generation with ${model} (Attempt ${attempt}/${retries})`);
        return await ai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.7,
          }
        });
      } catch (error: any) {
        lastError = error;
        const errMsg = String(error?.message || error || "");
        const errStatus = error?.status || error?.code;

        const is429 = errStatus === 429 || errMsg.includes("429") || errMsg.toLowerCase().includes("quota");
        const is503 = errStatus === 503 || errMsg.includes("503") || errMsg.toLowerCase().includes("unavailable") || errMsg.toLowerCase().includes("high demand") || errMsg.toLowerCase().includes("temporary");

        if (is429) {
          const modelIndex = models.indexOf(model);
          if (modelIndex < models.length - 1) {
            console.warn(`[Gemini API Edge] Quota limit hit on ${model}. Switching to fallback model: ${models[modelIndex + 1]}...`);
            break; // try the next model
          }
        }

        if (is503 && attempt < retries) {
          console.warn(`[Gemini API Edge] Temporary Service Spike on ${model} (Attempt ${attempt}/${retries}). Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2; // exponential backoff
        } else {
          const modelIndex = models.indexOf(model);
          if (modelIndex < models.length - 1) {
            console.warn(`[Gemini API Edge] Failover from ${model} to fallback model ${models[modelIndex + 1]} due to: ${errMsg}`);
            break; // try the next model
          } else {
            console.error(`[Gemini API Edge] All Gemini models exhausted. Final error on ${model}: ${errMsg}`);
            throw error;
          }
        }
      }
    }
  }
  throw lastError;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { message, history, systemInstruction } = await req.json();

    if (!process.env.GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY is not configured in Vercel." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const contents = [];
    if (history && Array.isArray(history)) {
      for (const msg of history) {
        contents.push({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content || "" }]
        });
      }
    }
    contents.push({
      role: "user",
      parts: [{ text: message }]
    });

    const responseStream = await generateStreamWithRetry(contents, systemInstruction);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        
        // Heartbeat to keep connection alive
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch (e) { /* ignore if already closed */ }
        }, 10000);

        try {
          for await (const chunk of responseStream) {
            const content = chunk.text || "";
            
            if (content) {
              const data = JSON.stringify({ text: content });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          }
          // Signal stream completion explicitly
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err: any) {
          console.error("Stream Error:", err);
          const errorMsg = JSON.stringify({ error: err.message || "Streaming interrupted" });
          controller.enqueue(encoder.encode(`data: ${errorMsg}\n\n`));
        } finally {
          clearInterval(heartbeat);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
