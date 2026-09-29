/**
 * server.js — comment-to-DM webhook server (Facebook).
 *
 * Instagram is handled by InstantDM; this server processes Facebook Page
 * events only (gated by ENABLE_FB / ENABLE_IG in config).
 *
 * Policy basis (Meta's official docs):
 *  - Private Replies: ONE private reply per comment, within 7 days of the
 *    comment. Doc: https://developers.facebook.com/documentation/instagram-platform/private-replies/
 *  - Follow-ups only after the recipient replies; their reply opens the
 *    standard 24-hour messaging window (promotional content allowed inside it).
 *    Doc: https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy
 *  - Webhook verification + X-Hub-Signature-256:
 *    https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *
 * Run:  npm start        (needs .env — see .env.example)
 * Test: npm test         (scripts/selftest.sh, DRY_RUN mode)
 */
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { config } from './config.js';
import { loadState, saveState, isTerminal } from './state.js';
import { isTriggerComment } from './triggers.js';
import { TEMPLATES, fill, nextStep } from './classify.js';
import { parseWebhook } from './webhook.js';
import {
  igPrivateReply,
  igSendMessage,
  igCommentTimestamp,
  fbPrivateReply,
  fbSendMessage,
  fbCommentTimestamp,
  igPublicReply,
  fbPublicReply,
} from './meta.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

const app = express();
// Capture the raw body — signature verification MUST run over the raw bytes.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const key = (platform, senderId) => `${platform}:${senderId}`;

// --- webhook verification handshake -------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.VERIFY_TOKEN && challenge) {
    console.log('[webhook] verification handshake OK');
    return res.status(200).send(challenge); // raw challenge, no JSON
  }
  console.warn('[webhook] verification FAILED');
  return res.sendStatus(403);
});

// --- signature check ------------------------------------------------------------
function signatureValid(req) {
  const header = req.headers['x-hub-signature-256'];
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', config.APP_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- event intake ----------------------------------------------------------------
app.post('/webhook', (req, res) => {
  if (!signatureValid(req)) {
    console.warn('[webhook] invalid signature — rejected');
    return res.sendStatus(403);
  }
  res.sendStatus(200); // ACK fast; process async (Meta expects a quick 200)
  processBody(req.body).catch((err) => console.error('[webhook] processing error:', err));
});

async function processBody(body) {
  const events = parseWebhook(body);
  for (const ev of events) {
    try {
      // Platform toggles: Instagram is handled by InstantDM — this server is Facebook-only.
      if (ev.platform === 'ig' && !config.ENABLE_IG) {
        console.log('[webhook] ignoring IG event (platform disabled)');
        continue;
      }
      if (ev.platform === 'fb' && !config.ENABLE_FB) {
        console.log('[webhook] ignoring FB event (platform disabled)');
        continue;
      }
      if (ev.kind === 'comment') await handleComment(ev);
      else if (ev.kind === 'message') await handleMessage(ev);
    } catch (err) {
      console.error(`[webhook] ${ev.kind} handler error:`, err.message);
    }
  }
}

// --- comment → exact trigger → one private reply ---------------------------------
async function handleComment(ev) {
  const state = loadState();

  // dedup: Meta can redeliver; policy allows exactly one private reply per comment
  if (state.processed_comments[ev.commentId]) return;
  if (!ev.senderId || !ev.commentId) return;

  // never trigger on the owner's own comments
  const ownerAccountId = ev.platform === 'ig'
    ? config.IG_BUSINESS_ACCOUNT_ID || ev.ownerId
    : config.PAGE_ID || ev.ownerId;
  if (ev.senderId === ownerAccountId) return;

  // exact trigger rule — when in doubt, skip
  if (!isTriggerComment(ev.text)) return;

  const contactKey = key(ev.platform, ev.senderId);
  // one Step-1 per sender, ever
  if (state.contacts[contactKey]) {
    console.log(`[comment] ${ev.platform}:${ev.name} already contacted — skipping duplicate Step-1`);
    state.processed_comments[ev.commentId] = new Date().toISOString();
    saveState(state);
    return;
  }

  // freshness: private replies are only allowed within 7 days of the comment
  let commentTs;
  try {
    commentTs = ev.platform === 'ig'
      ? await igCommentTimestamp(ev.commentId)
      : await fbCommentTimestamp(ev.commentId);
  } catch (err) {
    console.warn(`[comment] could not fetch comment timestamp, skipping (fail-closed): ${err.message}`);
    return;
  }
  if (Date.now() - commentTs > SEVEN_DAYS_MS) {
    console.log(`[comment] trigger comment older than 7 days — skipping private reply`);
    state.processed_comments[ev.commentId] = new Date().toISOString();
    saveState(state);
    return;
  }

  const name = ev.name || 'there';
  const text = fill(TEMPLATES.STEP_1, name);
  const now = new Date().toISOString();

  let result;
  if (ev.platform === 'ig') {
    const igUserId = config.IG_BUSINESS_ACCOUNT_ID || ev.ownerId;
    if (!igUserId) {
      console.error('[comment] no IG business account ID — cannot send private reply');
      return;
    }
    result = await igPrivateReply({ igUserId, commentId: ev.commentId, text });
    if (result.ok && config.PUBLIC_REPLY_TEXT)
      await igPublicReply({ commentId: ev.commentId, text: config.PUBLIC_REPLY_TEXT });
  } else {
    result = await fbPrivateReply({ commentId: ev.commentId, text });
    if (result.ok && config.PUBLIC_REPLY_TEXT)
      await fbPublicReply({ commentId: ev.commentId, text: config.PUBLIC_REPLY_TEXT });
  }

  state.processed_comments[ev.commentId] = now;
  if (result.ok) {
    state.contacts[contactKey] = {
      platform: ev.platform,
      name: ev.name || null,
      sender_id: ev.senderId,
      state: 'awaiting_reply',
      step1_at: now,
      last_outbound_at: now,
      last_inbound_at: null,
      last_inbound_mid: null,
      email: null,
      format_asks: 0,
      email_asks: 0,
    };
    console.log(`[comment] Step-1 sent to ${ev.platform}:${name}`);
  } else {
    console.warn(`[comment] Step-1 FAILED for ${ev.platform}:${name} — state untouched, will not retry this comment`);
  }
  saveState(state);
}

// --- inbound message → state machine → reply-gated follow-up ---------------------
async function handleMessage(ev) {
  if (!ev.senderId || typeof ev.text !== 'string') return;
  const state = loadState();
  const contactKey = key(ev.platform, ev.senderId);
  const contact = state.contacts[contactKey];

  // only people we messaged first (via the comment trigger) get follow-ups
  if (!contact || isTerminal(contact)) return;
  // ignore our own sends (extra safety beyond echo filtering)
  const ownerAccountId = ev.platform === 'ig'
    ? config.IG_BUSINESS_ACCOUNT_ID || ev.ownerId
    : config.PAGE_ID || ev.ownerId;
  if (ev.senderId === ownerAccountId) return;
  // duplicate delivery guard
  if (ev.mid && ev.mid === contact.last_inbound_mid) return;

  // reply-gating: only act on inbound messages NEWER than our last outbound
  const lastOutbound = Date.parse(contact.last_outbound_at || 0);
  if (!(ev.ts > lastOutbound)) return;

  const decision = nextStep(contact, ev.text);

  if (decision.action === 'optout') {
    contact.state = 'opted_out';
    contact.last_inbound_at = new Date(ev.ts).toISOString();
    contact.last_inbound_mid = ev.mid || null;
    saveState(state);
    console.log(`[message] ${ev.platform}:${contact.name} opted out — silenced permanently`);
    return;
  }

  if (decision.action === 'none') {
    if (decision.newState) contact.state = decision.newState;
    contact.last_inbound_at = new Date(ev.ts).toISOString();
    contact.last_inbound_mid = ev.mid || null;
    saveState(state);
    console.log(`[message] ${ev.platform}:${contact.name} → no reply warranted (${contact.state})`);
    return;
  }

  // 24-hour window: their reply opens it; follow-ups must go out inside it
  if (Date.now() - ev.ts > WINDOW_24H_MS) {
    console.log(`[message] ${ev.platform}:${contact.name} reply is older than 24h — follow-up skipped`);
    contact.last_inbound_at = new Date(ev.ts).toISOString();
    contact.last_inbound_mid = ev.mid || null;
    saveState(state);
    return;
  }

  const text = fill(TEMPLATES[decision.template], contact.name);
  const now = new Date().toISOString();
  let result;
  if (ev.platform === 'ig') {
    const igUserId = config.IG_BUSINESS_ACCOUNT_ID || ev.ownerId;
    result = await igSendMessage({ igUserId, recipientId: ev.senderId, text });
  } else {
    const pageId = config.PAGE_ID || ev.ownerId;
    result = await fbSendMessage({ pageId, recipientId: ev.senderId, text });
  }

  contact.last_inbound_at = new Date(ev.ts).toISOString();
  contact.last_inbound_mid = ev.mid || null;
  if (decision.bump) contact[decision.bump] = (contact[decision.bump] || 0) + 1;
  if (decision.newState) contact.state = decision.newState;

  if (result.ok) {
    contact.last_outbound_at = now;
    console.log(`[message] ${ev.platform}:${contact.name} → sent ${decision.template} (state=${contact.state})`);
    if (decision.saveEmail) {
      contact.email = decision.saveEmail;
      logLead({ platform: ev.platform, name: contact.name, sender_id: ev.senderId, email: decision.saveEmail });
    }
  } else {
    console.warn(`[message] ${ev.platform}:${contact.name} → FAILED to send ${decision.template}; state saved as ${contact.state} (outbound time untouched)`);
  }
  saveState(state);
}

function logLead(lead) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...lead });
  appendFileSync(config.LEADS_PATH, line + '\n');
  console.log(`[LEAD] ${lead.name} <${lead.email}> (${lead.platform}) — saved to leads.jsonl`);
}

// --- health / status ----------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, dry_run: config.DRY_RUN }));
app.get('/', (_req, res) =>
  res.type('text').send(
    `alexkouba-comment-to-dm — ${config.DRY_RUN ? 'DRY_RUN (preview only)' : 'LIVE'}\n` +
      'GET  /webhook  — Meta verification handshake\n' +
      'POST /webhook  — event intake (signature-verified)\n'
  )
);

app.listen(config.PORT, () => {
  console.log(`[server] listening on :${config.PORT} — ${config.DRY_RUN ? 'DRY_RUN preview mode' : 'LIVE mode'}`);
});
