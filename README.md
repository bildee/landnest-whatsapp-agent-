# Landnest WhatsApp AI Agent

A minimal webhook that connects the Landnest Community Lead WhatsApp Business
number to Claude, so it auto-answers FAQs from leads/realtors and flags
anything it can't confidently handle to a human.

The agent's knowledge comes from three layers, combined into what Claude
sees on every message:
1. `knowledge-base.js` — hand-written facts and tone/escalation rules (most reliable, edit this directly).
2. The **Landnest website** — auto-fetched from the pages you list in `config/sources.js`.
3. **Uploaded FAQ PDFs** — dropped in via an upload endpoint, parsed to text automatically.

**Scope, on purpose:** this only handles 1:1 chats. WhatsApp's API cannot
post into or manage Groups (see the "why not group automation" note in the
project chat) - use this for the Community Lead's direct messages, and keep
group posts human-sent (optionally drafted with Claude first).

---

## What you need before you start

1. A **Meta Business Account** with the Landnest number already added as a
   WhatsApp Business number (you said this is already in place).
2. A **Meta App** with the WhatsApp product added — set this up at
   [developers.facebook.com](https://developers.facebook.com) if not done:
   - Create App → type "Business" → add the "WhatsApp" product.
   - Under WhatsApp > API Setup you'll get a **temporary access token**, a
     **Phone Number ID**, and can send test messages immediately.
   - For production (so the token doesn't expire every 24h), generate a
     **permanent token**: System Users (Business Settings) → create a system
     user → assign the WhatsApp app → generate token with
     `whatsapp_business_messaging` + `whatsapp_business_management`
     permissions.
3. An **Anthropic API key** — console.anthropic.com → Get API Key. Add a
   little credit (a few dollars covers a lot of messages at this volume).
4. Somewhere to host this — **Render** free tier is the easiest (steps
   below). Railway or Fly.io work the same way.

---

## 1. Fill in the knowledge base

Open `knowledge-base.js` and replace every `[EDIT: ...]` block with real
Landnest info — active projects, sales partner process, what's safe to say
about pricing, office contact. This file is the *entire* source of truth for
the agent — it will not know anything you don't put here, and it's
instructed not to guess.

## 2. Point it at the Landnest website

Open `config/sources.js` and list the real URLs worth the agent knowing —
homepage, about page, FAQ page, individual project pages. Keep it to actual
content pages, not nav/cart/login. The agent re-fetches these every time the
server restarts, plus on demand (see admin endpoints below).

This is a straightforward "fetch page → strip HTML → hand the text to
Claude" approach, not a search index — good for a handful of pages that
comfortably fit in context. If the site grows to dozens of pages, ask me and
I'll switch this to proper retrieval (only pulling in the relevant page per
question) instead of stuffing everything in every time.

## 3. Set your environment variables

Copy `.env.example` to `.env` and fill in:

```
WHATSAPP_TOKEN=...
PHONE_NUMBER_ID=...
VERIFY_TOKEN=landnest_verify_2026    # make up any string
ANTHROPIC_API_KEY=...
HANDOFF_NUMBER=2348...               # your or the Community Lead's number
ADMIN_SECRET=some_long_random_string # protects the admin endpoints below
```

## 4. Run it locally to test

```bash
npm install
npm start
```

This starts a server on port 3000. To let Meta reach it before you deploy,
you can temporarily tunnel it with `ngrok http 3000` and use the ngrok URL
in the next step — or skip straight to deploying (below), which is more
reliable for a real launch.

## 5. Deploy (Render free tier)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com) → New → Web Service → connect the
   repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add the same environment variables from your `.env` in Render's
   dashboard (Environment tab).
5. Deploy. Render gives you a URL like
   `https://landnest-agent.onrender.com`.

Note: Render's free tier sleeps after inactivity and takes ~30s to wake on
the next message — fine for FAQ replies, just know the first reply after a
quiet period will be slightly slow. Upgrade to a paid instance ($7/mo) if
that delay matters.

## 6. Point Meta at your webhook

In Meta App Dashboard → WhatsApp → Configuration:
- Callback URL: `https://your-app.onrender.com/webhook`
- Verify token: same string you put in `VERIFY_TOKEN`
- Click Verify and Save.
- Under "Webhook fields," subscribe to `messages`.

## 7. Test it

Message the Landnest business number from your personal phone. You should
get a Claude-generated reply within a couple seconds (or ~30s if the free
Render instance was asleep).

---

## Uploading FAQ PDFs

Once deployed, upload a PDF from your terminal (replace with your real URL
and secret):

```bash
curl -F "file=@/path/to/Landnest-FAQ.pdf" \
  "https://your-app.onrender.com/admin/upload-faq?secret=YOUR_ADMIN_SECRET"
```

You'll get back a JSON confirmation with how many characters were extracted.
The PDF's text is immediately folded into the agent's knowledge — no
restart needed. No command line handy? Any tool that can send a
multipart-form POST works too (Postman, Insomnia, etc.) — field name is
`file`.

To re-scan every PDF already on the server (e.g. after manually copying
files onto it):

```
GET https://your-app.onrender.com/admin/reparse-faqs?secret=YOUR_ADMIN_SECRET
```

## Refreshing website content on demand

The site is re-fetched automatically on every server restart. To force a
refresh without restarting (e.g. after Landnest updates a project page):

```
GET https://your-app.onrender.com/admin/refresh-website?secret=YOUR_ADMIN_SECRET
```

## Checking what the agent currently knows

Useful for debugging a wrong answer — this shows the exact combined prompt
Claude is working from:

```
GET https://your-app.onrender.com/admin/knowledge-preview?secret=YOUR_ADMIN_SECRET
```

---

## How the handoff works

When the agent isn't confident (pricing negotiation, complaints, explicit
"let me talk to a person" requests), it prefixes its reply with `[HANDOFF]`.
The code strips that tag before the lead sees it, and separately notifies
`HANDOFF_NUMBER` with the original question and what the agent said, so a
human can follow up.

## Extending this later

- **Images/documents**: `message.type` will be `image`/`document` instead of
  `text` — the code currently ignores those; add handling if leads send
  screenshots.
- **Persistent history**: conversation history is in-memory and resets on
  restart/redeploy. Fine to start; swap the `Map` for Redis or a small DB
  if you want memory to survive restarts.
- **Larger website/FAQ libraries**: the current approach stuffs all fetched
  content into every request. Works well for a handful of pages/documents.
  If Landnest's site or FAQ library grows large, the next step is proper
  retrieval (embeddings + vector search) so only the relevant snippet gets
  pulled in per question — keeps costs down and avoids context limits.
- **Cost from Oct 1, 2026**: Meta is introducing charges for AI-agent
  replies inside the service window around this date. Rates weren't final
  as of this build — worth checking developers.facebook.com/docs/whatsapp
  closer to the date.
