require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const fs = require('fs');
const baseInstructions = require('./knowledge-base');
const { refreshWebsiteKnowledge, loadCachedWebsiteKnowledge } = require('./lib/fetchWebsite');
const { parseAndCachePdf, loadAllFaqKnowledge, reparseAllPdfs, PDF_DIR } = require('./lib/pdfKnowledge');

const app = express();
app.use(express.json());
const upload = multer({
  dest: PDF_DIR,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per PDF
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype === 'application/pdf');
  },
});

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
  HANDOFF_NUMBER,
  ADMIN_SECRET,
  PORT = 3000,
} = process.env;

// ---------- Knowledge assembly ----------
// Combined system prompt = fixed instructions + latest website scrape +
// latest parsed FAQ PDFs. Rebuilt in memory whenever a source refreshes.
let websiteKnowledge = loadCachedWebsiteKnowledge();
let faqKnowledge = loadAllFaqKnowledge();

function buildSystemPrompt() {
  let prompt = baseInstructions;
  if (websiteKnowledge) {
    prompt += `\n\n---\nADDITIONAL CONTEXT FROM THE LANDNEST WEBSITE (use this to answer accurately, but the tone/escalation rules above still apply):\n${websiteKnowledge}`;
  }
  if (faqKnowledge) {
    prompt += `\n\n---\nADDITIONAL CONTEXT FROM UPLOADED FAQ DOCUMENTS:\n${faqKnowledge}`;
  }
  return prompt;
}

// In-memory per-sender conversation history (resets on restart).
const conversations = new Map();
const HISTORY_LIMIT = 10;

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET || req.query.secret !== ADMIN_SECRET) {
    return res.status(401).send('Unauthorized. Pass ?secret=YOUR_ADMIN_SECRET');
  }
  next();
}

// ---------- Webhook verification ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- Incoming messages ----------
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack fast, Meta retries on timeout

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const text = message.text?.body;
    if (!text) return; // extend here for image/document message types

    console.log(`Incoming from ${from}: ${text}`);

    const reply = await getClaudeReply(from, text);
    const isHandoff = reply.startsWith('[HANDOFF]');
    const cleanReply = isHandoff ? reply.replace('[HANDOFF]', '').trim() : reply;

    await sendWhatsAppMessage(from, cleanReply);

    if (isHandoff && HANDOFF_NUMBER) {
      await sendWhatsAppMessage(
        HANDOFF_NUMBER,
        `Handoff needed.\nFrom: ${from}\nMessage: "${text}"\nAgent replied: "${cleanReply}"`
      );
    }
  } catch (err) {
    console.error('Error handling incoming message:', err);
  }
});

// ---------- Admin: manually trigger a website re-crawl ----------
// GET so you can trigger it from a browser: https://your-app/admin/refresh-website?secret=...
app.get('/admin/refresh-website', requireAdmin, async (_req, res) => {
  try {
    websiteKnowledge = await refreshWebsiteKnowledge();
    res.json({ ok: true, chars: websiteKnowledge.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Admin: upload a FAQ PDF ----------
// curl -F "file=@faq.pdf" "https://your-app/admin/upload-faq?secret=..."
app.post('/admin/upload-faq', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No PDF file provided (field name: file)' });
    const buffer = fs.readFileSync(req.file.path);
    const text = await parseAndCachePdf(buffer, req.file.originalname);
    faqKnowledge = loadAllFaqKnowledge(); // refresh combined cache
    res.json({ ok: true, filename: req.file.originalname, extractedChars: text.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Admin: re-parse any PDFs dropped directly into knowledge/faqs ----------
app.get('/admin/reparse-faqs', requireAdmin, async (_req, res) => {
  try {
    faqKnowledge = await reparseAllPdfs();
    res.json({ ok: true, chars: faqKnowledge.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Admin: see what the agent currently knows ----------
app.get('/admin/knowledge-preview', requireAdmin, (_req, res) => {
  res.type('text/plain').send(buildSystemPrompt());
});

// ---------- Ask Claude for a reply, using per-sender history ----------
async function getClaudeReply(senderId, userText) {
  const history = conversations.get(senderId) || [];
  history.push({ role: 'user', content: userText });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system: buildSystemPrompt(),
      messages: history,
    }),
  });

  if (!response.ok) {
    console.error('Claude API error:', await response.text());
    return "[HANDOFF] Sorry, I'm having trouble right now - let me get someone to help you.";
  }

  const data = await response.json();
  const replyText = data.content?.find((b) => b.type === 'text')?.text?.trim()
    || "[HANDOFF] Let me get someone to help you with that.";

  history.push({ role: 'assistant', content: replyText });
  conversations.set(senderId, history.slice(-HISTORY_LIMIT));

  return replyText;
}

// ---------- Send a message back via WhatsApp Cloud API ----------
async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  if (!res.ok) console.error('WhatsApp send error:', await res.text());
}

app.get('/', (_req, res) => res.send('Landnest WhatsApp agent is running.'));

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  // Do an initial website fetch on startup so the agent has fresh content
  // without waiting for a manual /admin/refresh-website call.
  try {
    websiteKnowledge = await refreshWebsiteKnowledge();
    console.log('Website knowledge loaded on startup.');
  } catch (err) {
    console.error('Initial website fetch failed (will use cache if any):', err.message);
  }
});
