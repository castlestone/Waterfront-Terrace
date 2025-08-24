// /functions/chat.js
// Cloudflare Pages Function → OpenAI Responses API + File Search (streaming SSE)
// Env vars required (Pages → Settings → Variables and Secrets):
//   - OPENAI_API_KEY (Secret)
//   - OPENAI_VECTOR_STORE_ID (vs_...; Variable or Secret)
//   - SYSTEM_PROMPT (optional)
//   - MODEL_ID (optional; default "gpt-4.1-mini")

const MODEL_FALLBACK = "gpt-4.1-mini";
const ALLOWED_ORIGINS = ["*"]; // tighten to your domain(s) in production

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export const onRequestOptions = async ({ request }) =>
  new Response(null, { headers: cors(request.headers.get("Origin")) });

export const onRequestPost = async ({ request, env }) => {
  const origin = request.headers.get("Origin");
  if (ALLOWED_ORIGINS[0] !== "*" && !ALLOWED_ORIGINS.includes(origin)) {
    return new Response("Forbidden", { status: 403, headers: cors(origin) });
  }

  // 1) Parse JSON body
  let body;
  try { body = await request.json(); }
  catch { return new Response("Bad JSON", { status: 400, headers: cors(origin) }); }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return new Response("Missing 'message'", { status: 400, headers: cors(origin) });

  // 2) Env checks
  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) {
    return new Response("Server not configured (OPENAI_API_KEY / OPENAI_VECTOR_STORE_ID)", {
      status: 500, headers: cors(origin)
    });
  }

  const model = env.MODEL_ID || MODEL_FALLBACK;
  const systemPrompt =
    env.SYSTEM_PROMPT ||
    "Answer only using the provided documents. If not present, say: \"I don't know based on the provided documents.\"";

  // 3) Build Responses payload — File Search configured on the tool
  const payload = {
    model,
    instructions: systemPrompt,
    tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
    input: userMessage,
    stream: true
  };

  // 4) Call OpenAI (streaming)
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(`Upstream error: ${upstream.status} ${text}`, {
      status: 502, headers: cors(origin)
    });
  }

  // 5) Stream transform → forward chunks + collect *real* sources from file_search results
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let full = "";
  const foundFiles = new Map(); // file_id -> filename

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = "";

      const sendJSON = (obj) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

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

            // Each `data:` line is a JSON event from the Responses stream
            try {
              const evt = JSON.parse(data);

              // A) Text deltas or chunks
              if (typeof evt?.delta === "string") {
                full += evt.delta;
                sendJSON({ output_text: evt.delta });
              } else if (typeof evt?.output_text === "string") {
                full += evt.output_text;
                sendJSON({ output_text: evt.output_text });
              }

              // B) File Search results (collect true sources)
              // Events can vary; look for any event that carries `results`
              if (evt?.results && Array.isArray(evt.results)) {
                for (const r of evt.results) {
                  const f = r.file || {};
                  const id = f.id || r.file_id;
                  if (!id) continue;
                  const name = f.filename || r.filename || id;
                  foundFiles.set(id, name);
                }
              }

              // C) Some streams nest tool calls under a generic event; be permissive:
              if (evt?.type && String(evt.type).includes("file_search") && evt?.results) {
                for (const r of evt.results) {
                  const f = r.file || {};
                  const id = f.id || r.file_id;
                  if (!id) continue;
                  const name = f.filename || r.filename || id;
                  foundFiles.set(id, name);
                }
              }
            } catch {
              // ignore non-JSON lines
            }
          }

          buffer = lines[lines.length - 1];
        }

        // Final event: include full text + deduped filenames from actual tool results
        const sources = Array.from(foundFiles.values());
        sendJSON({ done: true, final: full, sources });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();

      } catch (err) {
        controller.error(err);
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      ...cors(origin)
    }
  });
};
