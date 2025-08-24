// /functions/chat2.js
const MODEL_FALLBACK = "gpt-4.1-mini";

export const onRequestPost = async ({ request, env }) => {
  let body;
  try { body = await request.json(); } catch { 
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers: { "Content-Type": "application/json" }});
  }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) {
    return new Response(JSON.stringify({ error: "Missing 'message'" }), { status: 400, headers: { "Content-Type": "application/json" }});
  }

  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) {
    return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY or OPENAI_VECTOR_STORE_ID" }), { status: 500, headers: { "Content-Type": "application/json" }});
  }

  const model = env.MODEL_ID || MODEL_FALLBACK;
  const systemPrompt =
    env.SYSTEM_PROMPT ||
    "Answer only using the provided documents. If not present, say you don't know.";

  // ✅ Responses API: vector store goes on the tool itself (no attachments)
  const payload = {
    model,
    instructions: systemPrompt,
    tools: [{
      type: "file_search",
      vector_store_ids: [vectorStoreId]
    }],
    input: userMessage,
    stream: false
  };

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" }
  });
};
