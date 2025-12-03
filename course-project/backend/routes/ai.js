// routes/ai.js
const express = require("express");
const router = express.Router();

// Node 18+ has global fetch. For Node <=17, uncomment:
// const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

/** === IMPORTANT: point the AI service to your real backend base ===
 * If you move environments, just set process.env.API_BASE instead.
 */
const API_BASE = process.env.API_BASE || "https://backend-production-09c4.up.railway.app";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const INCLUDE_ROLE_PREFIX = process.env.AI_INCLUDE_ROLE === "1";
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

// === Session / snapshot ===
const SESS_TTL_MS = 5 * 60 * 1000;             // refresh data snapshot every 5 minutes
const MAX_HISTORY_PAIRS = 6;                   // replay last N Q/A pairs
const AI_CTX_LIMIT = parseInt(process.env.AI_CTX_LIMIT || "200", 10); // list cap for data block

// userId -> { bootstrapped, lastBootstrap, history[], me, events[], txns[], dataBlock }
const sessions = new Map();

const SYSTEM_PROMPT = `You are Prestige Assistant for a points & events program.
- Be concise (2–5 sentences).
- Respect roles (regular, cashier, manager, superuser). Don't reveal manager-only actions to regular users.
- When asked about actions (RSVP, cancel, publish), explain steps and point to the right page instead of "doing" it.
- If unsure, say so and suggest opening the event details page.
- Do not mention the user's role in responses unless they explicitly ask.`;

// ----------------------------
// Intent helpers
// ----------------------------
function wantsUpcoming(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /\b(upcoming|next|soon)\b.*\bevents?\b/.test(t) ||
    /\bevents?\b.*\b(upcoming|next|soon|today|tomorrow|this week)\b/.test(t) ||
    /^events?\b/.test(t) ||
    /\bwhat'?s on\b/.test(t)
  );
}
function parseLimitFromText(text) {
  if (!text) return null;
  const m =
    text.match(/(?:top|first|next)\s+(\d{1,2})\b/i) ||
    text.match(/\b(\d{1,2})\s+(?:events?)\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 20) return n;
  }
  return null;
}
function wantsMyRsvps(text) {
  if (!text) return false;
  const t = text
    .toLowerCase()
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/rsvp[- ]?ed/g, "rsvped")
    .replace(/\brsvp\b\s*to\b/g, "rsvped to");
  return (
    /\bwhat\b.*\bevents?\b.*\b(am|i)\b.*\b(rsvped|registered|signed up|attending|going)\b/.test(t) ||
    /\bmy\b.*\b(rsvps?|registrations?|events?)\b/.test(t) ||
    /\b(show|list|see|display)\b.*\bmy\b.*\b(rsvps?|registrations?|events?)\b/.test(t)
  );
}
function wantsOrganizing(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /\b(what|which)\b.*\bevents?\b.*\b(i|am)\b.*\b(organis(?:e|ing)|organiz(?:e|ing)|hosting|running)\b/.test(t) ||
    /\bmy\b.*\b(organized|organised|organizing|hosting)\b.*\bevents?\b/.test(t)
  );
}
function parseDateHint(text) {
  const t = (text || "").toLowerCase();
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (/\btoday\b/.test(t)) {
    start.setHours(0,0,0,0); end.setHours(23,59,59,999); return { start, end };
  }
  if (/\btomorrow\b/.test(t)) {
    start.setDate(start.getDate() + 1); start.setHours(0,0,0,0);
    end.setTime(start.getTime()); end.setHours(23,59,59,999); return { start, end };
  }
  if (/\bthis week\b/.test(t)) {
    const day = (now.getDay() + 6) % 7; // Monday start
    start.setDate(now.getDate() - day); start.setHours(0,0,0,0);
    end.setTime(start.getTime()); end.setDate(start.getDate() + 6); end.setHours(23,59,59,999);
    return { start, end };
  }
  return null;
}

// ----------------------------
// Formatting helpers
// ----------------------------
function fmtDate(d) {
  try { const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return ""; }
}
function fmtTime(d) {
  try { const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
}
function timeRange(ev) {
  const s = ev?.startTime ? new Date(ev.startTime) : null;
  const e = ev?.endTime ? new Date(ev.endTime) : null;
  if (s && e) return `${fmtDate(s)} ${fmtTime(s)}–${fmtTime(e)}`;
  if (s) return `${fmtDate(s)} ${fmtTime(s)}`;
  return "";
}
function formatEventsList(events) {
  const lines = events.map((ev) => {
    const when = timeRange(ev);
    const loc = ev.location ? ` @ ${ev.location}` : "";
    const spots =
      typeof ev.guestsCount === "number" && typeof ev.capacity === "number"
        ? ` (${ev.guestsCount}/${ev.capacity})` : "";
    return `• ${ev.name}${when ? ` — ${when}` : ""}${loc}${spots}`;
  });
  return lines.length ? lines.join("\n") : "";
}

async function synthesizeReply(text) {
  if (!ELEVEN_KEY || !text) return null;
  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE)}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
    });
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    return buffer.toString("base64");
  } catch (e) {
    console.error("tts error", e);
    return null;
  }
}

// ----------------------------
// Data fetchers (use absolute API_BASE)
// ----------------------------
async function fetchMe(req) {
  try {
    const resp = await fetch(`${API_BASE}/users/me`, {
      headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "" }
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

function isMe(idOrVal, me) {
  if (!me) return false;
  const myId = String(me.id ?? me._id ?? "");
  const myUtor = (me.utorid || me.utorId || me.username || "").toLowerCase();
  const v = (idOrVal ?? "").toString().toLowerCase();
  return v && (v === myId.toLowerCase() || v === myUtor);
}

function normalizeEvent(ev, me) {
  const guests = Array.isArray(ev.guests) ? ev.guests : [];
  const guestsCount =
    ev.guestsCount ??
    ev.guests_count ??
    ev.numGuests ??
    (Array.isArray(guests) ? guests.length : undefined);

  const meRsvped =
    !!(ev.meRsvped ?? ev.rsvped ?? ev.isRsvped ?? ev.registered) ||
    guests.some(g => isMe(g?.id ?? g?.userId ?? g?.utorid ?? g?.email, me));

  const organizers =
    Array.isArray(ev.organizers) ? ev.organizers :
    Array.isArray(ev.organiser) ? ev.organiser :
    [];

  const ownerId = ev.ownerId ?? ev.createdBy ?? ev.owner ?? null;

  return {
    id: ev.id ?? ev._id ?? ev.eventId ?? ev.uuid,
    name: ev.name ?? ev.title ?? "Untitled event",
    description:
      ev.description ?? ev.eventDescription ?? ev.longDescription ?? ev.details ?? ev.summary ?? ev.desc ?? "",
    location: ev.location ?? ev.where ?? "",
    startTime: ev.startTime ?? ev.start_time,
    endTime: ev.endTime ?? ev.end_time,
    capacity: ev.capacity,
    guestsCount,
    published: ev.published ?? ev.isPublished ?? ev.is_published,
    meRsvped,
    organizers,
    ownerId,
  };
}

async function fetchAllEvents(req, me) {
  const out = [];
  const limit = 100;
  let page = 1;

  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      showFull: "true",
      includeMe: "true",
      includeGuests: "true",
      includeOrganizers: "true",
    });

    const resp = await fetch(`${API_BASE}/events?${params.toString()}`, {
      headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "" }
    });
    if (!resp.ok) break;

    const data = await resp.json();
    const items = data.items || data.results || data.events || (Array.isArray(data) ? data : []);
    if (!items.length) break;

    for (const raw of items) out.push(normalizeEvent(raw, me));

    const totalPages = data.totalPages || Math.ceil((data.total ?? data.count ?? out.length) / limit) || 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return out;
}

async function fetchTransactions(req) {
  try {
    const resp = await fetch(`${API_BASE}/transactions?page=1&limit=200`, {
      headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "" }
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const items = data.items || data.results || data.transactions || (Array.isArray(data) ? data : []);
    return items.map(t => ({
      id: t.id ?? t._id ?? t.uuid,
      points: t.points ?? t.amount ?? 0,
      type: t.type ?? t.kind ?? "",
      createdAt: t.createdAt ?? t.time ?? t.date ?? null,
      note: t.note ?? t.reason ?? "",
      eventId: t.eventId ?? null,
    }));
  } catch {
    return [];
  }
}

// ----------------------------
// Snapshot / data block
// ----------------------------
function splitEvents(events) {
  const now = Date.now();
  const upcoming = [];
  const past = [];
  for (const e of events) {
    const s = e.startTime ? Date.parse(e.startTime) : NaN;
    const en = e.endTime ? Date.parse(e.endTime) : NaN;
    const isUpcoming =
      (Number.isFinite(s) && s >= now) ||
      (!Number.isFinite(s) && Number.isFinite(en) && en >= now) ||
      (Number.isFinite(s) && Number.isFinite(en) && s < now && en >= now);
    (isUpcoming ? upcoming : past).push(e);
  }
  upcoming.sort((a, b) => {
    const sa = a.startTime ? Date.parse(a.startTime) : (a.endTime ? Date.parse(a.endTime) : Number.POSITIVE_INFINITY);
    const sb = b.startTime ? Date.parse(b.startTime) : (b.endTime ? Date.parse(b.endTime) : Number.POSITIVE_INFINITY);
    return sa - sb;
  });
  past.sort((a, b) => {
    const ea = a.endTime ? Date.parse(a.endTime) : (a.startTime ? Date.parse(a.startTime) : 0);
    const eb = b.endTime ? Date.parse(b.endTime) : (b.startTime ? Date.parse(b.startTime) : 0);
    return eb - ea; // newest past first
  });
  return { upcoming, past };
}

function eventsOrganizedByMe(events, me) {
  const myId = me?.id ?? me?._id;
  if (!myId) return [];
  return events.filter(e => {
    if (e.ownerId && String(e.ownerId) === String(myId)) return true;
    if (Array.isArray(e.organizers)) {
      return e.organizers.some(o => String(o?.id ?? o?.userId ?? o) === String(myId));
    }
    return false;
  });
}

function buildDataBlock({ me, events, txns }) {
  const { upcoming, past } = splitEvents(events);
  const rsvps = events.filter(e => e.meRsvped);
  const organizing = eventsOrganizedByMe(events, me);

  const cap = (arr) => arr.slice(0, AI_CTX_LIMIT);

  const simpleEvent = (e) => ({
    id: e.id, name: e.name, location: e.location,
    startTime: e.startTime, endTime: e.endTime,
    capacity: e.capacity, guestsCount: e.guestsCount,
    published: e.published, meRsvped: e.meRsvped
  });

  const payload = {
    user: {
      id: me?.id ?? me?._id ?? null,
      name: me?.name ?? me?.fullName ?? me?.displayName ?? null,
      utorid: me?.utorid ?? me?.utorId ?? me?.username ?? null,
      role: me?.role ?? null,
      points: me?.points ?? me?.balance ?? null,
    },
    counts: {
      totalEvents: events.length,
      upcoming: upcoming.length,
      past: past.length,
      rsvps: rsvps.length,
      organizing: organizing.length,
      transactions: txns.length,
    },
    rsvps: cap(rsvps).map(simpleEvent),
    organizing: cap(organizing).map(simpleEvent),
    upcoming: cap(upcoming).map(simpleEvent),
    past: cap(past).map(simpleEvent),
    transactions: cap(txns).map(t => ({
      id: t.id, type: t.type, points: t.points, createdAt: t.createdAt, note: t.note, eventId: t.eventId
    })),
  };

  return "DATA_SNAPSHOT:\n" + JSON.stringify(payload, null, 2);
}

async function bootstrapSession(req, userId) {
  const me = (await fetchMe(req)) || { id: userId };
  const [events, txns] = await Promise.all([
    fetchAllEvents(req, me),
    fetchTransactions(req),
  ]);
  const dataBlock = buildDataBlock({ me, events, txns });
  return { me, events, txns, dataBlock };
}

// ----------------------------
// Routes
// ----------------------------
router.get("/ping", (req, res) => {
  const me = req.auth || null; // express-jwt v8 (if present)
  return res.json({ ok: true, model: GEMINI_MODEL, role: me?.role ?? null, apiBase: API_BASE });
});

router.post("/chat", async (req, res) => {
  try {
    if (!GEMINI_KEY) return res.status(500).json({ reply: "AI key not configured." });

    const raw = typeof req.body?.message === "string" ? req.body.message : "";
    const userMessage = raw.trim().slice(0, 2000);
    if (!userMessage) return res.status(400).json({ reply: "message is required" });

    // user id / role from JWT (if using express-jwt). Fallback: decode Bearer.
    const meJwt = req.auth || {};
    const role = meJwt.role || "regular";
    const userId =
      (meJwt && (meJwt.id || meJwt.userId)) ||
      (() => {
        try {
          const authz = req.headers.authorization || "";
          const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
          if (!token) return "unknown";
          const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
          return payload?.id ?? "unknown";
        } catch { return "unknown"; }
      })();

    const sendReply = async (text, extra = {}) => {
      const audioBase64 = await synthesizeReply(text);
      return res.json({
        reply: text,
        model: GEMINI_MODEL,
        roleSeen: role,
        audioBase64,
        ...extra,
      });
    };

    // session
    let sess = sessions.get(String(userId));
    if (!sess) {
      sess = { bootstrapped: false, lastBootstrap: 0, history: [], me: null, events: [], txns: [], dataBlock: "" };
      sessions.set(String(userId), sess);
    }
    if (!sess.bootstrapped || (Date.now() - sess.lastBootstrap) > SESS_TTL_MS) {
      const snap = await bootstrapSession(req, userId);
      Object.assign(sess, snap, { bootstrapped: true, lastBootstrap: Date.now() });
    }

    const lower = userMessage.toLowerCase();
    const limit = parseLimitFromText(lower) || 3;

    // ---- Intent: upcoming events (from snapshot) ----
    if (wantsUpcoming(lower)) {
      const { upcoming } = splitEvents(sess.events);
      const top = upcoming.slice(0, limit);
      const text = top.length
        ? `Here are the next ${top.length} upcoming events:\n${formatEventsList(top)}`
        : "I couldn't find any upcoming events.";
      return sendReply(text, { intent: "upcoming" });
    }

    // ---- Intent: my RSVPs (from snapshot) ----
    if (wantsMyRsvps(lower)) {
      const range = parseDateHint(lower);
      const nowTs = Date.now();
      let mine = sess.events.filter(e => e.meRsvped);
      if (range) {
        const startMs = +range.start, endMs = +range.end;
        mine = mine.filter(e => {
          const s = e.startTime ? Date.parse(e.startTime) : NaN;
          return Number.isFinite(s) && s >= startMs && s <= endMs;
        });
      }
      // upcoming only
      mine = mine.filter(e => {
        const s = e.startTime ? Date.parse(e.startTime) : NaN;
        const en = e.endTime ? Date.parse(e.endTime) : NaN;
        return (Number.isFinite(s) && s >= nowTs) ||
               (Number.isFinite(s) && Number.isFinite(en) && s < nowTs && en >= nowTs);
      });
      mine.sort((a, b) => Date.parse(a.startTime || a.endTime || 0) - Date.parse(b.startTime || b.endTime || 0));

      if (!mine.length) return sendReply(`You have no upcoming RSVP’d events${range ? " in that period" : ""}.`, { intent: "my-rsvps" });

      const top = mine.slice(0, limit);
      const list = formatEventsList(top);
      return sendReply(`Your next ${top.length} RSVP’d events:\n${list}`, { intent: "my-rsvps" });
    }

    // ---- Intent: events I’m organizing (from snapshot) ----
    if (wantsOrganizing(lower)) {
      const org = eventsOrganizedByMe(sess.events, sess.me);
      if (!org.length) return sendReply("You are not listed as an organizer for any events.", { intent: "organizing" });
      const top = org.slice(0, limit);
      return sendReply(`You’re organizing ${top.length} event(s):\n${formatEventsList(top)}`, { intent: "organizing" });
    }

    // ---- General Q/A with full data block up front + short history ----
    const contents = [];
    if (sess.dataBlock) {
      contents.push({ role: "user", parts: [{ text: sess.dataBlock }] });
    }
    if (Array.isArray(sess.history) && sess.history.length) contents.push(...sess.history);
    contents.push({ role: "user", parts: [{ text: userMessage }] });

    const payload = {
      system_instruction: { role: "system", parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { temperature: 0.5, topP: 0.9 },
      contents,
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent?key=${GEMINI_KEY}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Gemini API error:", resp.status, errText);
      return res.status(500).json({ reply: "AI is unavailable right now." });
    }

    const data = await resp.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const replyRaw = parts.map(p => p.text).filter(Boolean).join("\n") || "Sorry, I’m not sure.";

    let final = replyRaw.trim();
    if (INCLUDE_ROLE_PREFIX) {
      const tag = `(role: ${role}) `;
      if (!final.startsWith(tag)) final = `${tag}${final}`;
    }

    // Update short history
    try {
      sess.history.push({ role: "user", parts: [{ text: userMessage }] });
      sess.history.push({ role: "model", parts: [{ text: final }] });
      const maxMsgs = MAX_HISTORY_PAIRS * 2;
      if (sess.history.length > maxMsgs) {
        sess.history = sess.history.slice(sess.history.length - maxMsgs);
      }
    } catch {}

    return sendReply(final);
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: "Error contacting AI" });
  }
});

// Optional: synthesize arbitrary text to speech for replays
router.post("/tts", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(500).json({ error: "TTS not configured" });
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  const audioBase64 = await synthesizeReply(text);
  if (!audioBase64) return res.status(500).json({ error: "TTS failed" });
  return res.json({ audioBase64 });
});

module.exports = router;
