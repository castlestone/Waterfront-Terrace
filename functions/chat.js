// /functions/chat.js
// Cloudflare Pages Function → OpenAI Responses API + File Search (streaming SSE)
// Env vars: OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID; optional: SYSTEM_PROMPT, MODEL_ID

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

  // Parse
  let body;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400, headers: cors(origin) }); }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return new Response("Missing 'message'", { status: 400, headers: cors(origin) });

  // Env
  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) {
    return new Response("Server not configured (OPENAI_API_KEY / OPENAI_VECTOR_STORE_ID)", { status: 500, headers: cors(origin) });
  }
  const model = env.MODEL_ID || MODEL_FALLBACK;
const systemPrompt =
  env.SYSTEM_PROMPT ||
  `
You are a condominium governance assistant for Halifax County Condominium Corporation No. 227 ("HCCC #227").

### Style & Formatting
- Always answer in **Markdown**.
- Use **headings** (##, ###) to structure responses.
- Organize details with **bullet points** or numbered lists.
- Keep a professional but accessible tone: formal enough for board use, plain enough for unit owners.

### Rules
- Use **only the uploaded governing documents** (Declaration, By-laws, Nova Scotia Condominium Act, Nova Scotia Condominium Regulations).
- Always cite the source document (name and section/article).
- If the answer is not explicitly covered, reply:  
  "This is not covered in the official governing documents of HCCC #227."
- Never speculate or invent information.
`;


  // ---- Helpers ----
  const stripExt = (name) => {
    if (!name) return name;
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
  };

  // Pretty labels tailored to your four docs
  function prettyTitle(rawName) {
    const name = (rawName || "").toLowerCase();
    // Normalize common tokens
    const normalized = rawName
      .replace(/_/g, " ")
      .replace(/\b(final|official|accepted|amendment|rev|ver|v\d+)\b/ig, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    const hccc = "Halifax County Condominium Corporation No. 227";

    if (name.includes("by-law") || name.includes("bylaws") || name.includes("by-laws")) {
      return `By-laws of ${hccc}`;
    }
    if (name.includes("declaration")) {
      // If you like, detect "amendment" separately and format it differently.
      return `Declaration of ${hccc}`;
    }
    if (name.includes("condominium act")) {
      return `The Nova Scotia Condominium Act`;
    }
    if (name.includes("regulation")) {
      return `The Nova Scotia Condominium Regulations`;
    }
    return stripExt(normalized);
  }

  async function preloadFileMap(vsId) {
    // Build map: file_id -> filename for everything in this store
    const fileMap = new Map();
    const headers = { Authorization: `Bearer ${apiKey}` };

    const vsResp = await fetch(`https://api.openai.com/v1/vector_stores/${vsId}/files`, { headers });
    if (vsResp.ok) {
      const { data = [] } = await vsResp.json();
      // Resolve each id → filename
      await Promise.all(
        data.map(async (item) => {
          try {
            const r = await fetch(`https://api.openai.com/v1/files/${item.id}`, { headers });
            if (r.ok) {
              const j = await r.json();
              if (j?.id) fileMap.set(j.id, j.filename || j.id);
            }
          } catch {}
        })
      );
    }
    return fileMap; // may be empty if store has no files
  }

  const payload = {
    model,
    instructions: systemPrompt,
    tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
    input: userMessage,
    stream: true
  };

  // Preload store filenames (best-effort)
  const fileMapPromise = preloadFileMap(vectorStoreId);

  // Call OpenAI
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(`Upstream error: ${upstream.status} ${text}`, { status: 502, headers: cors(origin) });
  }

  // Stream transform
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let full = "";
  const usedIds = new Set();
  const nameHints = new Map(); // if we see any names in events

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = "";

      const sendJSON = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

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

              // A) Text chunks
              if (typeof evt?.delta === "string") {
                full += evt.delta;
                sendJSON({ output_text: evt.delta });
              } else if (typeof evt?.output_text === "string") {
                full += evt.output_text;
                sendJSON({ output_text: evt.output_text });
              }

              // B) File Search results: collect file IDs (cover common shapes)
              const candidates = [];
              if (evt?.results && Array.isArray(evt.results)) candidates.push(...evt.results);
              if (evt?.type && String(evt.type).includes("file_search") && Array.isArray(evt.results)) candidates.push(...evt.results);

              for (const r of candidates) {
                const f = r.file || {};
                const id = f.id || r.file_id;
                if (!id) continue;
                usedIds.add(id);
                const hint = f.filename || r.filename || r.display_name || r.name;
                if (hint) nameHints.set(id, hint);
              }
            } catch {
              // ignore non-JSON lines
            }
          }
          buffer = lines[lines.length - 1];
        }

        // Build final sources (prefer true filenames from store map, else resolve per-id, else hint)
        const headers = { Authorization: `Bearer ${apiKey}` };
        const fileMap = await fileMapPromise.catch(() => new Map());
        const sources = [];
        for (const id of usedIds) {
          let name = fileMap.get(id);
          if (!name) {
            // fallback: resolve this id now
            try {
              const r = await fetch(`https://api.openai.com/v1/files/${id}`, { headers });
              if (r.ok) {
                const j = await r.json();
                name = j.filename || nameHints.get(id) || id;
              } else {
                name = nameHints.get(id) || id;
              }
            } catch {
              name = nameHints.get(id) || id;
            }
          }
          sources.push(prettyTitle(stripExt(name)));
        }

        // Deduplicate & keep order
        const finalSources = [...new Set(sources)];

        // Final event
        sendJSON({ done: true, final: full, sources: finalSources });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors(origin) }
  });
};
