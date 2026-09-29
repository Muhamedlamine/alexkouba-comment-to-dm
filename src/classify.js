/**
 * classify.js — reply classification and the conversation state machine.
 *
 * Message templates are in Alex's casual voice. There is deliberately NO
 * marketing-style opt-out phrasing in outgoing messages; incoming opt-out
 * requests are still honored silently.
 */

// --- Offer context (constants; also mirrored in README) -------------------
export const OFFER = {
  name: 'How to Buy Your First Business — Step by Step',
  city: 'Toronto',
  session1: 'Saturday, September 26th 2026, 10am–4pm EDT',
  address: '95 King St E, Toronto',
  price: '$249 CAD',
  session2: 'Saturday, October 10th 2026, 10am–4pm EDT',
  link: 'https://www.thealexkouba.com/ma-workshop',
};

export const TEMPLATES = {
  STEP_1:
    'Hey {Name}! Saw you dropped BUSINESS on my post — are you thinking about buying your first business?',
  ASK_DATE:
    "Awesome! It's in person on September 26th, 10am–4pm — will you be able to make that?",
  SEND_LINK:
    "Perfect — here's the link to grab your seat: https://www.thealexkouba.com/ma-workshop",
  ASK_FORMAT:
    'No worries! Would you rather do it online, or in person on another day?',
  FORMAT_CLARIFY:
    'Just to confirm — would you prefer online, or in person on October 10th?',
  TELL_NEXT_DATE:
    "We've got another one two weeks later — Saturday, October 10th, same time 10am–4pm. Want the link for that one?",
  ASK_EMAIL:
    "Got it — drop me your email and I'll let you know as soon as we launch the online one.",
  EMAIL_ASK_AGAIN:
    'Could you send me the email address? I want to make sure you get the update.',
  EMAIL_CONFIRM: "You're on the list — I'll email you the moment it's live.",
  NO_CLOSE: 'No worries at all — if that ever changes, you know where to find me.',
};

export function fill(template, name) {
  return template.replace('{Name}', name || 'there');
}

// --- matching helpers ------------------------------------------------------
function norm(text) {
  return (text || '').toLowerCase().replace(/[’‘]/g, "'").trim();
}
function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** whole-word match (so "no" doesn't fire inside "nobody") */
function hasWord(text, word) {
  return new RegExp(`\\b${escRe(word)}\\b`, 'i').test(text);
}
function hasAnyWord(text, words) {
  return words.some((w) => hasWord(text, w));
}
/** substring/phrase match on normalized text */
function hasPhrase(text, phrase) {
  return norm(text).includes(phrase);
}
function hasAnyPhrase(text, phrases) {
  return phrases.some((p) => hasPhrase(text, p));
}

const OPT_OUT_PHRASES = [
  'unsubscribe',
  'opt out',
  'opt-out',
  'optout',
  "don't message me",
  'do not message me',
  "don't text me",
  'do not text me',
  'leave me alone',
  'stop messaging',
  'stop texting',
  'remove me',
];
const OPT_OUT_WORDS = ['stop', 'unsubscribe'];

const NO_WORDS = ['no', 'nah', 'nope', 'pass'];
const NO_PHRASES = [
  'not really',
  'not right now',
  'not interested',
  "can't",
  'cannot',
  "won't",
  'not for me',
];
const CANT_MAKE_IT_PHRASES = ['busy', 'not that day', 'another day', "can't make", 'cannot make'];

const YES_WORDS = ['yes', 'yeah', 'yep', 'yup', 'sure', 'absolutely', 'definitely', 'ok', 'okay'];
const YES_PHRASES = [
  'yes please',
  'count me in',
  'sounds good',
  'i can',
  "i'll be there",
  'ill be there',
  "i'm in",
  'im in',
  'i am in',
  'sign me up',
  "let's do it",
  'lets do it',
];

const ONLINE_WORDS = ['online', 'virtual', 'zoom', 'remote'];
const INPERSON_PHRASES = [
  'in person',
  'in-person',
  'another day',
  'other day',
  'other date',
  'next one',
  'october',
  'oct 10',
  'october 10',
];

export function isOptOut(text) {
  const t = norm(text);
  return hasAnyWord(t, OPT_OUT_WORDS) || hasAnyPhrase(t, OPT_OUT_PHRASES);
}
export function isNoLike(text) {
  const t = norm(text);
  return hasAnyWord(t, NO_WORDS) || hasAnyPhrase(t, NO_PHRASES);
}
export function isCantMakeIt(text) {
  return isNoLike(text) || hasAnyPhrase(norm(text), CANT_MAKE_IT_PHRASES);
}
export function isYesLike(text) {
  const t = norm(text);
  return hasAnyWord(t, YES_WORDS) || hasAnyPhrase(t, YES_PHRASES);
}
export function isOnlineLike(text) {
  return hasAnyWord(norm(text), ONLINE_WORDS);
}
export function isInPersonLike(text) {
  return hasAnyPhrase(norm(text), INPERSON_PHRASES);
}

const EMAIL_RE = /\S+@\S+\.\S+/;
export function extractEmail(text) {
  const m = (text || '').match(EMAIL_RE);
  return m ? m[0].replace(/[.,;:!?)\]]+$/, '') : null;
}

/**
 * nextStep(contact, inboundText) → decision for an inbound reply.
 *
 * Returns one of:
 *   { action: 'send', template, newState, saveEmail? }
 *   { action: 'optout' }   — mark opted_out, send nothing
 *   { action: 'none' }      — send nothing, leave state as-is
 *   { action: 'stay', template } — send a clarification, keep state
 */
export function nextStep(contact, inboundText) {
  if (isOptOut(inboundText)) return { action: 'optout' };

  switch (contact.state) {
    case 'awaiting_reply':
      // "are you thinking about buying your first business?"
      if (isNoLike(inboundText)) return { action: 'send', template: 'NO_CLOSE', newState: 'done' };
      return { action: 'send', template: 'ASK_DATE', newState: 'asked_date' };

    case 'asked_date':
      // "will you be able to make September 26th?"
      if (isYesLike(inboundText)) return { action: 'send', template: 'SEND_LINK', newState: 'done' };
      // no-like AND unclear both route to the format question — never loop asking
      return { action: 'send', template: 'ASK_FORMAT', newState: 'asked_format' };

    case 'asked_format': {
      // "online, or in person on another day?"
      if (isOnlineLike(inboundText))
        return { action: 'send', template: 'ASK_EMAIL', newState: 'collecting_email' };
      if (isInPersonLike(inboundText))
        return { action: 'send', template: 'TELL_NEXT_DATE', newState: 'told_next_date' };
      if ((contact.format_asks || 0) < 1)
        return { action: 'stay', template: 'FORMAT_CLARIFY', bump: 'format_asks' };
      return { action: 'none', newState: 'done' }; // give up quietly — never loop
    }

    case 'told_next_date':
      // offered Oct 10, asked "want the link?"
      if (isNoLike(inboundText)) return { action: 'send', template: 'NO_CLOSE', newState: 'done' };
      return { action: 'send', template: 'SEND_LINK', newState: 'done' };

    case 'collecting_email': {
      const email = extractEmail(inboundText);
      if (email) return { action: 'send', template: 'EMAIL_CONFIRM', newState: 'done', saveEmail: email };
      if ((contact.email_asks || 0) < 1)
        return { action: 'stay', template: 'EMAIL_ASK_AGAIN', bump: 'email_asks' };
      return { action: 'none', newState: 'done' }; // give up quietly — never loop
    }

    default:
      return { action: 'none' };
  }
}
