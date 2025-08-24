// /functions/chat.js
// Cloudflare Pages Function → OpenAI Responses API + File Search (streaming SSE)
// Env vars: OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID, optional SYSTEM_PROMPT, MODEL_ID

const MODEL_FALLBACK = "gpt-4.1-mini";
const ALLOWED_ORIGINS = ["*"]; // tighten in prod

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export const onRequestOptions = async ({ request }) =>
  new Response(null, { headers: corsHeaders(request.headers.get("Origin")) });

export const onRequestPost = async ({ request, env }) => {
  const origin = request.headers.get("Origin");
  if (ALLOWED_ORIGINS[0] !== "*" && !ALLOWED_ORIGINS.includes(origin))
    return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });

  // Parse JSON body
  let body;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400, headers: corsHeaders(origin) }); }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return new Response("Missing 'message'", { status: 400, headers: corsHeaders(origin) });

  // Env checks
  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId)
    return new Response("Server not configured (OPENAI_API_KEY / OPENAI_VECTOR_STORE_ID)", { status: 500, headers: corsHeaders(origin) });

  const model = env.MODEL_ID || MODEL_FALLBACK;
  const systemPrompt =
    env.SYSTEM_PROMPT ||
    "Answer only using the provided documents. If not present, say: \"I don't know based on the provided documents.\"";

  // ✅ Responses API: link vector store on the file_search tool (no attachments/tool_resources)
  const payload = {
    model,
    instructions: systemPrompt,
    tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
    input: userMessage,
    stream: true,
  };

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(`Upstream error: ${upstream.status} ${text}`, { status: 502, headers: corsHeaders(origin) });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let full = "";

  function extractSources(ans) {
    const m = /(?:^|\n)\s*Sources:\s*(.+)\s*$/i.exec(ans || "");
    if (!m) return [];
    return m[1].split(/[;,]/).map(s => s.trim()).filter(Boolean);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = "";
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

            try {
              const evt = JSON.parse(data);
              if (typeof evt?.delta === "string") {
                full += evt.delta;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ output_text: evt.delta })}\n\n`));
              } else if (typeof evt?.output_text === "string") {
                full += evt.output_text;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ output_text: evt.output_text })}\n\n`));
              }
            } catch {
              // ignore non-JSON lines
            }
          }
          buffer = lines[lines.length - 1];
        }

        // Final event with the whole answer + parsed sources
        const sources = extractSources(full);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, final: full, sources })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders(origin) },
  });
};
