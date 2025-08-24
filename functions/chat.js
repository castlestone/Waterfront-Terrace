// /functions/chat.js
// Cloudflare Pages Function → OpenAI Responses API + File Search (streaming SSE)
// Env vars required: OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID
// Optional: SYSTEM_PROMPT, MODEL_ID

const MODEL_FALLBACK = "gpt-4.1-mini";
const ALLOWED_ORIGINS = ["*"]; // tighten in prod

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

  // 3) Responses payload — File Search configured on the tool (no attachments/tool_resources)
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

  // 5) Stream transform → forward chunks + collect REAL sources (file IDs)
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let full = "";
  const fileIds = new Set();     // collect file_id(s) from tool results
  const nameHints = new Map();   // file_id -> any name seen in events (may be generic)

  // helper: strip final extension (e.g., ".pdf"); keeps names with dots elsewhere intact
  const stripExt = (name) => {
    if (!name) return name;
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
  };

  async function resolveDisplayNames(ids) {
    const out = [];
    for (const id of ids) {
      try {
        const r = await fetch(`https://api.openai.com/v1/files/${id}`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (r.ok) {
          const j = await r.json();
          out.push(stripExt(j.filename || id));
        } else {
          out.push(stripExt(nameHints.get(id) || id));
        }
      } catch {
        out.push(stripExt(nameHints.get(id) || id));
      }
    }
    // Dedup while preserving order
    return [...new Set(out)];
  }

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

            try {
              const evt = JSON.parse(data);

              // A) Text deltas/chunks
              if (typeof evt?.delta === "string") {
                full += evt.delta;
                sendJSON({ output_text: evt.delta });
              } else if (typeof evt?.output_text === "string") {
                full += evt.output_text;
                sendJSON({ output_text: evt.output_text });
              }

              // B) Collect file IDs from tool results (covering common shapes)
              const candidates = [];
              if (evt?.results && Array.isArray(evt.results)) candidates.push(...evt.results);
              if (evt?.type && String(evt.type).includes("file_search") && Array.isArray(evt.results)) candidates.push(...evt.results);

              for (const r of candidates) {
                const f = r.file || {};
                const id = f.id || r.file_id;
                if (!id) continue;
                fileIds.add(id);
                const hint = f.filename || r.filename || r.display_name || r.name;
                if (hint) nameHints.set(id, hint);
              }
            } catch {
              // ignore non-JSON lines
            }
          }

          buffer = lines[lines.length - 1];
        }

        // Resolve IDs → filenames (without extensions) for display
        const sources = await resolveDisplayNames(fileIds);

        // Final event
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
