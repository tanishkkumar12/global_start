import { generateSystemPrompt } from "./utils";
import { RestaurantConfig } from "./types";

async function callOpenRouterClientSideStream(
  apiKey: string,
  message: string,
  history: { role: string; content?: string; text?: string }[],
  systemInstruction: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
) {
  const models = [
    "google/gemini-2.5-flash",
    "google/gemini-flash-1.5",
    "meta-llama/llama-3.1-8b-instruct",
    "deepseek/deepseek-r1-distill-llama-8b"
  ];

  const historyMessages = history.map((msg) => ({
    role: msg.role === "user" ? "user" : "assistant",
    content: msg.content || msg.text || ""
  }));

  const messages = [
    ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
    ...historyMessages,
    { role: "user", content: message }
  ];

  let lastErr: any = null;

  for (const model of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "https://ai.studio/build",
          "X-Title": "Restaurant Applet",
        },
        signal,
        body: JSON.stringify({
          model,
          messages,
          stream: true,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`OpenRouter ${model} status ${res.status}: ${errText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response reader");

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
            if (dataStr === "[DONE]") {
              return; // Success!
            }
            try {
              const parsed = JSON.parse(dataStr);
              const text = parsed.choices?.[0]?.delta?.content;
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
      console.warn(`[Client-side OpenRouter] Model ${model} failed:`, err);
    }
  }

  throw lastErr || new Error("Client-side OpenRouter streaming failed");
}

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

    // 2. Client-side Gemini fallback if key is configured locally
    const customKey = typeof window !== "undefined" ? localStorage.getItem("resto_gemini_api_key") : null;
    const viteKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    const clientGeminiKey = (customKey || viteKey || "").trim();

    if (clientGeminiKey) {
      console.log("[AIService] Server /api/chat unavailable. Trying direct client-side Gemini call...");
      try {
        await callGeminiClientSideStream(
          clientGeminiKey,
          message,
          history,
          this.systemInstruction,
          onChunk,
          signal
        );
        return; // Client-side Gemini streaming succeeded!
      } catch (clientErr: any) {
        if (clientErr.name === "AbortError") throw clientErr;
        console.warn("[AIService] Client-side Gemini call failed, trying OpenRouter fallback...", clientErr);
      }
    }

    // 3. Client-side OpenRouter fallback if user entered a custom key or VITE_OPENROUTER_API_KEY
    const customOpenRouterKey = typeof window !== "undefined" ? localStorage.getItem("resto_openrouter_api_key") : null;
    const viteOpenRouterKey = (import.meta as any).env?.VITE_OPENROUTER_API_KEY;
    const openRouterKeyToUse = (customOpenRouterKey || viteOpenRouterKey || "").trim();

    if (openRouterKeyToUse) {
      console.log("[AIService] Attempting direct client-side OpenRouter fallback...");
      try {
        await callOpenRouterClientSideStream(
          openRouterKeyToUse,
          message,
          history,
          this.systemInstruction,
          onChunk,
          signal
        );
        return; // Client-side OpenRouter streaming succeeded!
      } catch (orErr: any) {
        if (orErr.name === "AbortError") throw orErr;
        console.error("[AIService] Client-side OpenRouter call failed:", orErr);
        serverErrorMsg = orErr.message || serverErrorMsg;
      }
    }

    // 4. Construct error message if all failed
    onChunk(`\n\n[AI Connection Notice: Could not connect to AI services. Please try again in a few seconds or check your OpenRouter API key.]`);
  }
}
