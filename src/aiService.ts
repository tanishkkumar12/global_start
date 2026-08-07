import { generateSystemPrompt } from "./utils";
import { RestaurantConfig } from "./types";

async function callGeminiClientSideStream(
  apiKey: string,
  message: string,
  history: { role: string; content?: string; text?: string }[],
  systemInstruction: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
) {
  const models = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
  ];
  let lastErr: any = null;

  for (const model of models) {
    try {
      const contents = history.map((h) => ({
        role: h.role === "user" ? "user" : "model",
        parts: [{ text: h.content || h.text || "" }],
      }));
      contents.push({ role: "user", parts: [{ text: message }] });

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            systemInstruction: systemInstruction
              ? { parts: [{ text: systemInstruction }] }
              : undefined,
            contents,
          }),
        }
      );

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${res.status}: ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body reader");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let lineIndex;
        while ((lineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, lineIndex).trim();
          buffer = buffer.slice(lineIndex + 1);

          if (line.startsWith("data:")) {
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;
            try {
              const parsed = JSON.parse(dataStr);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                onChunk(text);
              }
            } catch (e) {
              /* ignore partial json */
            }
          }
        }
      }
      return; // Success!
    } catch (err: any) {
      if (err.name === "AbortError") throw err;
      lastErr = err;
      console.warn(`[Client-side Gemini] Model ${model} failed:`, err);
    }
  }
  throw lastErr || new Error("Client-side Gemini streaming failed");
}

export class AIService {
  private systemInstruction: string;

  constructor(config: RestaurantConfig) {
    this.systemInstruction = generateSystemPrompt(config);
  }

  async sendMessageStream(
    message: string, 
    history: { role: string; text: string }[], 
    onChunk: (chunk: string) => void, 
    signal?: AbortSignal
  ) {
    let serverFailed = false;
    let serverErrorMsg = "";
    let serverStatusCode = 0;

    // 1. Try server endpoint /api/chat first
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          message,
          history: history.map(h => ({ 
            role: h.role === "user" ? "user" : "assistant", 
            content: h.text 
          })),
          systemInstruction: this.systemInstruction,
        }),
      });

      serverStatusCode = response.status;

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        serverErrorMsg = errorData.error || `HTTP ${response.status}: ${response.statusText || "Request failed"}`;
        serverFailed = true;
      } else {
        const reader = response.body?.getReader();
        if (!reader) {
          serverFailed = true;
          serverErrorMsg = "No response stream reader available";
        } else {
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            
            let lineIndex;
            while ((lineIndex = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, lineIndex).trim();
              buffer = buffer.slice(lineIndex + 1);

              if (line.startsWith("data:")) {
                const data = line.slice(5).trim();
                
                if (data === "[DONE]") {
                  return; // Successfully finished streaming
                }
                
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.error) {
                    const msg = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error));
                    serverFailed = true;
                    serverErrorMsg = msg;
                    break;
                  }
                  if (parsed.text !== undefined) {
                    onChunk(parsed.text);
                  }
                } catch (e) {
                  // Fallback string extraction if needed
                  if (data && data !== ":" && !data.includes("keepalive") && !data.includes("heartbeat")) {
                    const match = data.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                    if (match && match[1]) {
                      try {
                        onChunk(JSON.parse(`"${match[1]}"`));
                      } catch (innerE) { /* skip */ }
                    }
                  }
                }
              }
            }
            if (serverFailed) break;
          }
          if (!serverFailed) return; // Success!
        }
      }
    } catch (error: any) {
      if (error.name === "AbortError") throw error;
      serverFailed = true;
      serverErrorMsg = error.message || "Network / connection error";
      console.warn("Server /api/chat error:", error);
    }

    // 2. If server failed, check for client-side API key fallback
    const customKey = typeof window !== "undefined" ? localStorage.getItem("resto_gemini_api_key") : null;
    const viteKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    const clientApiKey = (customKey || viteKey || "").trim();

    if (clientApiKey) {
      console.log("[AIService] Server /api/chat unavailable. Attempting direct client-side Gemini call...");
      try {
        await callGeminiClientSideStream(
          clientApiKey,
          message,
          history,
          this.systemInstruction,
          onChunk,
          signal
        );
        return; // Client-side streaming succeeded!
      } catch (clientErr: any) {
        if (clientErr.name === "AbortError") throw clientErr;
        console.error("[AIService] Client-side Gemini call also failed:", clientErr);
        serverErrorMsg = clientErr.message || serverErrorMsg;
      }
    }

    // 3. Construct explicit, actionable error message for the user
    let userFriendlyMsg = "";
    const lowerErr = serverErrorMsg.toLowerCase();

    if (serverStatusCode === 404 || lowerErr.includes("404") || lowerErr.includes("not found")) {
      userFriendlyMsg = "The server AI endpoint (/api/chat) was not found (404). If you hosted this as a static site (e.g. GitHub Pages or Netlify static), please go to Admin Configuration -> AI Virtual Host and enter your Gemini API Key to enable direct client-side AI chat!";
    } else if (lowerErr.includes("gemini_api_key") || lowerErr.includes("key is not configured") || lowerErr.includes("key is missing")) {
      userFriendlyMsg = "The GEMINI_API_KEY environment variable is not configured on your host server. Please add `GEMINI_API_KEY` to your deployment environment variables (Vercel, Netlify, Cloud Run), or enter a custom key in the Admin Configuration panel!";
    } else if (lowerErr.includes("503") || lowerErr.includes("unavailable") || lowerErr.includes("high demand") || lowerErr.includes("temporary") || lowerErr.includes("busy")) {
      userFriendlyMsg = "The AI service is experiencing a temporary spike in high demand (Error 503). Please wait a few seconds and send your message again! Our menu and kitchen ordering remain fully operational.";
    } else if (lowerErr.includes("429") || lowerErr.includes("rate limit") || lowerErr.includes("quota")) {
      userFriendlyMsg = "The AI service rate limit was reached (Error 429). Please wait a few seconds before sending another message.";
    } else if (serverErrorMsg) {
      userFriendlyMsg = `AI connection error: ${serverErrorMsg}. Please check your server environment variables or enter a custom Gemini API key in Admin Configuration.`;
    } else {
      userFriendlyMsg = "Could not connect to the AI host service. If you are hosting on a custom server, please ensure GEMINI_API_KEY is set in your environment variables or configure a key in Admin settings.";
    }

    onChunk(`\n\n[AI Connection Notice: ${userFriendlyMsg}]`);
  }
}
