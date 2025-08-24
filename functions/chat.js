// /functions/chat.js
// Cloudflare Pages Function → Proxies to OpenAI Responses API with File Search.
// Env vars required in Cloudflare Pages → Settings → Variables and Secrets:
//   - OPENAI_API_KEY            (Secret)
//   - OPENAI_VECTOR_STORE_ID    (Variable or Secret, looks like vs_...)
//   - SYSTEM_PROMPT             (Variable, your governance prompt)
//   - MODEL_ID                  (Variable, optional; default "gpt-4.1-mini")

const MODEL_FALLBACK = "gpt-4.1-mini";
const ALLOWED_ORIGINS = ["*"]; // tighten to your domains in production

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function sse(headers, stream) {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...headers },
  });
}

export const onRequestOptions = async ({ request }) => {
  const origin = request.headers.get("Origin") || "*";
  return new Response(null, { headers: corsHeaders(origin) });
};

export const onRequestPost = async ({ request, env }) => {
  const origin = request.headers.get("Origin") || "*";
  if (ALLOWED_ORIGINS[0] !== "*" && !ALLOWED_ORIGINS.includes(origin)) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
  }

  // Parse JSON body
  let body;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400, headers: corsHeaders(origin) }); }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return new Response("Missing 'message'", { status: 400, headers: corsHeaders(origin) });

  // Env checks
  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) {
    return new Response("Server not configured (missing OPENAI_API_KEY or OPENAI_VECTOR_STORE_ID)", { status: 500, headers: corsHeaders(origin) });
  }

  const model = env.MODEL_ID || MODEL_FALLBACK;
  const systemPrompt =
    env.SYSTEM_PROMPT ||
    "You are a domain-specific assistant. Answer only using the provided documents. If not present, reply: \"I don't know based on the provided documents.\"";

  // ✅ Responses API shape (File Search configured on the tool itself)
  const payload = {
    model,
    instructions: systemPrompt,
    tools: [
      {
        type: "file_search",
        // This is where the Vector Store is linked for Responses API:
        vector_store_ids: [vectorStoreId],
      },
    ],
    // Simple string input for Responses API
    input: userMessage,
    stream: true,
  };

  // Call OpenAI Responses (streaming)
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(`Upstream error: ${upstream.status} ${text}`, { status: 502, headers: corsHeaders(origin) });
  }

  // Transform OpenAI SSE → minimal SSE that your front-end expects:
  // front-end reads lines like: data: {"output_text":"chunk"}
  const readable = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const reader = upstream.body.getReader();
      let buffer = "";

      const sendText = (chunk) => {
        if (!chunk) return;
        const pkt = `data: ${JSON.stringify({ output_text: chunk })}\n\n`;
        controller.enqueue(encoder.encode(pkt));
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");

          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].trimStart();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            // Try to decode OpenAI event
            try {
              const evt = JSON.parse(data);
              // Responses API commonly sends delta events like:
              // { "type":"response.output_text.delta", "delta":"..." }
              if (typeof evt?.delta === "string") {
                sendText(evt.delta);
              } else if (typeof evt?.output_text === "string") {
                // Some events may include a full output_text chunk
                sendText(evt.output_text);
              }
              // Otherwise ignore; we only forward text chunks.
            } catch {
              // If it's not JSON, forward raw (rare)
              sendText(data);
            }
          }
          buffer = lines[lines.length - 1];
        }

        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return sse(corsHeaders(origin), readable);
};
