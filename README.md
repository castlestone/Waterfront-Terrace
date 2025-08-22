# Ask‑My‑Docs (One‑Page Landing + Chat)

A tiny one‑page site that answers questions **only** from your uploaded documents using the OpenAI API’s **File Search + Vector Stores** via the **Responses API**. Built for **Cloudflare Pages** (free tier).

## What you get
- Static landing page (`index.html`) with a minimal chat UI (streaming).
- Serverless function (`/functions/chat.js`) that proxies to OpenAI (keeps your key safe).
- Script to create a **Vector Store** and upload your docs (`scripts/upload_vector_store.mjs`).
- System prompt tuned for “answer only from provided docs.”

## Quick start

### 0) Prereqs
- Node 18+ installed locally.
- An OpenAI API key with access to the Responses API.

### 1) Put your PDFs/Markdown/TXT into **`docs/`**
Create the `docs` folder and drop your content in there. Example:
```
docs/
  policy.pdf
  faq.md
  handbook.txt
```

### 2) Create a vector store and upload docs
Install deps and run the setup script:
```bash
cd scripts
npm init -y
npm install openai@^4.58.0
export OPENAI_API_KEY=sk-...  # Windows (PowerShell): $Env:OPENAI_API_KEY='sk-...'
node upload_vector_store.mjs
```
The script will print a `VECTOR_STORE_ID`. Copy it.

### 3) Deploy to Cloudflare Pages
- Create a new Pages project (connect this folder as a repo, or drag‑and‑drop).
- Set **Environment Variables** in Pages → Settings:
  - `OPENAI_API_KEY` = your key
  - `OPENAI_VECTOR_STORE_ID` = the value printed by the setup script
  - (Optional) `SYSTEM_PROMPT` to override the default prompt
- No build command required (static). Root contains `index.html` and `/functions` for API routes.

### 4) Test locally (optional)
Cloudflare provides `wrangler pages dev` for local testing if desired.

### 5) Use it
Open your site, ask a question. The page streams results as they arrive. If the model can’t find relevant content, it will say it doesn’t know.

## Notes & tips
- **No ChatGPT “Custom GPT” embedding**: you can’t call a ChatGPT GPT directly from a site. This template uses the **OpenAI API** (Responses + File Search).
- Keep your doc set focused; high‑quality source docs = better answers.
- Model cost control: switch to a smaller model in `functions/chat.js` (search for `MODEL_ID`).

## Security
- Your API key only lives in the serverless function (never in the browser).
- Basic CORS is enforced; tweak `ALLOWED_ORIGINS` in `functions/chat.js` as needed.

## Credits
You, shipping quickly. Enjoy!
