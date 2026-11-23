'use strict';
// «أقنعة» — خادم اللعبة الجماعية اللحظية
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 30;
const MAX_IMG_BYTES = 2 * 1024 * 1024;       // حد الصورة الواحدة بعد الضغط
const MAX_ROOM_IMG_BYTES = 200 * 1024 * 1024; // حد صور الغرفة كاملة
const ROOM_TTL_MS = 8 * 60 * 60 * 1000;      // تُحذف الغرفة بعد 8 ساعات خمول
const PHASES = ['lobby', 'create', 'reveal', 'chat', 'vote', 'guess', 'results'];
const EMOJIS = ['😂', '😮', '🔥', '❤️', '🤔', '👏', '😱', '🕵️'];

const rooms = new Map();

const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, n);

let DEFAULT_NAMES = [];
try { DEFAULT_NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'names.default.json'), 'utf8')).map(n => clip(n, 24)).filter(Boolean); } catch { /* بدون قائمة افتراضية */ }

function newCode() {
  const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 5 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function freshGame(room) {
  room.phase = 'lobby';
  room.chars = new Map();        // playerId -> char (السرّ: ownerId لا يغادر الخادم قبل الكشف)
  room.order = [];               // ترتيب البطاقات (charIds) عشوائي
  room.revealed = new Set();
  room.cardReacts = new Map();   // charId -> Map(emoji -> Set(pid))
  room.questions = [];
  room.messages = [];
  room.msgReacts = new Map();     // msgId -> Map(emoji -> Set(pid))
  room.votes = new Map();        // pid -> charId (الجولة الحالية)
  room.voteNames = new Map();    // pid -> الاسم اللي يتوقعه صاحب الشخصية اللي صوّت عليها (وضع الإقصاء)
  room.elimHits = [];            // [{pid, charId, round}] تخمينات صحيحة كشفت شخصيات وقت التصويت
  room.pastVotes = [];           // أصوات الجولات السابقة: [{charId: count}]
  room.round = 1;
  room.eliminated = new Map();   // charId -> رقم الجولة اللي انقصت فيها
  room.guesses = new Map();      // pid -> {charId: pid}
  room.unmasked = [];            // charIds المكشوف أصحابها في النتائج
  room.showBoard = false;
  room.voteLocked = false;
  room.guessLocked = false;
}

function createRoom() {
  const room = {
    code: newCode(), hostToken: rid(18), hostSockets: new Set(),
    players: new Map(), tokens: new Map(), banned: new Set(),
    images: new Map(), imgBytes: 0, lastActive: now(), timer: null, dirty: false,
    // إعدادات يتحكم فيها المضيف
    settings: { names: [...DEFAULT_NAMES], pickName: DEFAULT_NAMES.length > 0, lateJoin: false, showAnswered: true, elimMode: true },
    bank: [],                    // بنك أسئلة جاهزة
  };
  freshGame(room);
  rooms.set(room.code, room);
  return room;
}

// ---------- أدوات الحالة ----------
const charById = (room, cid) => { for (const c of room.chars.values()) if (c.id === cid) return c; return null; };
const participants = (room) => [...room.chars.values()].filter(c => c.done).map(c => c.ownerId);
const isOut = (room, pid) => { const c = pid ? room.chars.get(pid) : null; return !!(c && room.eliminated.has(c.id)); };
const canVote = (room, pid) => room.players.has(pid) && !isOut(room, pid);
const curQ = (room) => room.questions[room.questions.length - 1] || null;
const isOpenQ = (q) => q && !q.closed;

// أسماء خيارات التخمين: قائمة المضيف + أسماء المشاركين غير الموجودة فيها
function guessNames(room) {
  const outNames = new Set([...room.eliminated.keys()].map(cid => room.players.get(charById(room, cid)?.ownerId)?.name));
  const out = room.settings.names.filter(n => !outNames.has(n));
  for (const pid of participants(room)) { const n = room.players.get(pid)?.name; if (n && !out.includes(n) && !outNames.has(n)) out.push(n); }
  return out;
}
const takenNames = (room) => [...room.players.values()].map(p => p.name);

function reactCounts(map, pid) {
  const counts = {}; const mine = [];
  if (map) for (const [e, set] of map) { if (set.size) counts[e] = set.size; if (set.has(pid)) mine.push(e); }
  return { counts, mine };
}

function publicChar(c) {
  return { id: c.id, name: c.name, bio: c.bio, tagline: c.tagline, avatar: c.avatar };
}

function computeResults(room) {
  const parts = participants(room);
  const pName = (pid) => room.players.get(pid)?.name || '—';
  const stats = new Map();
  for (const c of room.chars.values()) if (c.done) {
    let votes = 0, correct = 0, guessers = 0;
    for (const v of room.votes.values()) if (v === c.id) votes++;
    for (const r of room.pastVotes) votes += r[c.id] || 0;
    const owner = pName(c.ownerId);
    for (const [gp, g] of room.guesses) { if (gp === c.ownerId) continue; if (g[c.id]) { guessers++; if (g[c.id] === owner) correct++; } }
    stats.set(c.id, { votes, correct, guessers });
  }
  const scores = new Map();
  const add = (pid, k, v) => { if (!scores.has(pid)) scores.set(pid, { pid, name: pName(pid), votePts: 0, guessPts: 0, stealth: 0, titles: [] }); scores.get(pid)[k] += v; };
  for (const pid of parts) add(pid, 'votePts', 0);
  for (const c of room.chars.values()) if (c.done) {
    const s = stats.get(c.id);
    if (!room.settings.elimMode) add(c.ownerId, 'votePts', s.votes);
  }
  for (const h of room.elimHits) if (room.players.has(h.pid)) add(h.pid, 'votePts', 2);
  for (const c of room.chars.values()) if (c.done) {
    const s = stats.get(c.id);
    if (s.correct === 0 && !room.eliminated.has(c.id)) { add(c.ownerId, 'stealth', 3); scores.get(c.ownerId).titles.push('سيد التمويه'); }
  }
  for (const [gp, g] of room.guesses) {
    for (const [cid, guess] of Object.entries(g)) { const c = charById(room, cid); if (c && c.done && !room.eliminated.has(cid) && c.ownerId !== gp && guess === pName(c.ownerId)) add(gp, 'guessPts', 2); }
  }
  const board = [...scores.values()].filter(s => room.players.has(s.pid)).map(s => {
    const c = room.chars.get(s.pid);
    return { ...s, total: s.votePts + s.guessPts + s.stealth, charId: c && c.done ? c.id : null };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ar'));
  return { stats, board };
}

// لقطة حالة مخصصة لكل جهاز — هنا تُطبّق السرية
function snapshot(room, viewer) {
  const isHost = viewer.role === 'host';
  const pid = viewer.pid;
  const ph = room.phase;
  const myChar = pid ? room.chars.get(pid) : null;
  const parts = new Set(participants(room));
  const q = curQ(room);

  const players = [...room.players.values()].map(p => {
    const o = { id: p.id, name: p.name, connected: p.sockets.size > 0 };
    if (isHost) {
      const c = room.chars.get(p.id);
      o.done = !!(c && c.done);
      o.answered = !!(q && q.answered.has(p.id));
      o.voted = room.votes.has(p.id);
      o.out = isOut(room, p.id);
      o.guessed = room.guesses.has(p.id);
      o.participant = parts.has(p.id);
    }
    return o;
  });

  const s = {
    t: 'state', serverNow: now(), phase: ph, code: room.code, emojis: EMOJIS,
    you: { role: viewer.role, id: pid || null, name: pid ? room.players.get(pid)?.name : null },
    players, maxPlayers: MAX_PLAYERS,
    doneCount: parts.size,
    round: room.round, elimMode: room.settings.elimMode, voteLocked: room.voteLocked, guessLocked: room.guessLocked,
  };
  if (isHost) { s.settings = room.settings; s.bank = room.bank; }

  if (pid && myChar) {
    s.myChar = { ...publicChar(myChar), done: myChar.done };
  }

  if (PHASES.indexOf(ph) >= 2) {
    // البطاقات: في مرحلة الكشف تُرسل المقفلة بمعرّف فقط
    s.cards = room.order.map(cid => {
      const c = charById(room, cid);
      if (!c) return null;
      const open = ph !== 'reveal' || room.revealed.has(cid);
      const out = open ? { ...publicChar(c), open: true } : { id: cid, open: false };
      const r = reactCounts(room.cardReacts.get(cid), pid);
      out.reacts = r.counts; out.mine = r.mine;
      if (room.eliminated.has(cid)) { out.out = room.eliminated.get(cid); out.outOwner = room.players.get(c.ownerId)?.name || '—'; out.outOwnerId = c.ownerId; } // الصاحب ينكشف لحظة الإقصاء
      return out;
    }).filter(Boolean);
    s.myCharId = myChar && myChar.done ? myChar.id : null;
  }

  if (ph === 'chat') {
    s.question = q ? { id: q.id, text: q.text, endsAt: q.endsAt, closed: q.closed } : null;
    s.answeredCount = (isHost || room.settings.showAnswered) && q ? q.answered.size : null;
    s.answererTotal = [...parts].filter(p => !room.eliminated.has(room.chars.get(p)?.id)).length;
    s.iAnswered = !!(q && pid && q.answered.has(pid));
    s.questionCount = room.questions.length;
  }

  if (ph === 'vote') {
    s.myVote = pid ? room.votes.get(pid) || null : null;
    s.myVoteName = pid ? room.voteNames.get(pid) || null : null;
    s.iAmOut = isOut(room, pid);
    s.voteCount = [...room.votes.keys()].filter(v => canVote(room, v)).length; // العدد فقط، بدون لمن
    s.voterTotal = [...room.players.keys()].filter(v => canVote(room, v)).length;
    if (room.settings.elimMode) s.guessNames = guessNames(room);
    if (isHost) { const tally = {}; for (const [v, cid] of room.votes) if (canVote(room, v)) tally[cid] = (tally[cid] || 0) + 1; s.tally = tally; } // للمضيف فقط
  }

  if (ph === 'guess') {
    s.guessNames = guessNames(room);
    s.myGuesses = pid ? room.guesses.get(pid) || null : null;
    s.guessCount = room.guesses.size;
  }

  if (ph === 'results') {
    const { stats, board } = computeResults(room);
    s.unmasked = room.unmasked.map(cid => {
      const c = charById(room, cid); const st = stats.get(cid) || {};
      return c ? { charId: cid, ownerId: c.ownerId, ownerName: room.players.get(c.ownerId)?.name || '—', votes: st.votes, correct: st.correct, guessers: st.guessers } : null;
    }).filter(Boolean);
    s.totalToUnmask = room.order.length;
    s.myGuesses = pid ? room.guesses.get(pid) || null : null;
    s.showBoard = room.showBoard;
    if (room.showBoard) s.board = board;
  }
  return s;
}

function msgView(room, m, pid) {
  const r = reactCounts(room.msgReacts.get(m.id), pid);
  return { id: m.id, qid: m.qid, charId: m.charId, text: m.text, img: m.img, ts: m.ts, reacts: r.counts, mine: r.mine, own: !!pid && m.ownerId === pid };
}

function questionView(q) { return { id: q.id, text: q.text, ts: q.ts }; }

// ---------- البث ----------
function viewers(room) {
  const out = [];
  for (const ws of room.hostSockets) out.push(ws);
  for (const p of room.players.values()) for (const ws of p.sockets) out.push(ws);
  return out;
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

function scheduleState(room) {
  if (room.dirty) return;
  room.dirty = true;
  setImmediate(() => {
    room.dirty = false;
    for (const ws of viewers(room)) send(ws, snapshot(room, ws.viewer));
  });
}
function broadcastEach(room, fn) { for (const ws of viewers(room)) { const o = fn(ws.viewer); if (o) send(ws, o); } }

function sendHistory(room, ws) {
  const pid = ws.viewer.pid;
  send(ws, { t: 'history', questions: room.questions.map(questionView), messages: room.messages.map(m => msgView(room, m, pid)) });
}

// ---------- منطق المراحل ----------
function setPhase(room, ph) {
  if (!PHASES.includes(ph) || ph === room.phase) return;
  const from = room.phase;
  if (ph === 'reveal' || (PHASES.indexOf(ph) > 2 && room.order.length === 0)) {
    // تثبيت قائمة الشخصيات المكتملة بترتيب عشوائي
    for (const [pid, c] of room.chars) if (!c.done || !room.players.has(pid)) room.chars.delete(pid);
    if (room.order.length === 0 || from === 'create') room.order = shuffle([...room.chars.values()].map(c => c.id));
  }
  if (from === 'chat') { const q = curQ(room); if (isOpenQ(q)) closeQuestion(room, q, false); }
  if (ph === 'results') { room.unmasked = room.order.filter(id => room.eliminated.has(id)); room.showBoard = false; }
  room.phase = ph;
  // لقطة فورية لكل جهاز ثم سجل المحادثة، حتى تكون الشخصيات معروفة قبل الرسائل
  for (const ws of viewers(room)) { send(ws, snapshot(room, ws.viewer)); if (ph === 'chat') sendHistory(room, ws); }
}

function armTimer(room, q) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (!q.endsAt || q.closed) return;
  room.timer = setTimeout(() => { room.timer = null; closeQuestion(room, q); broadcastEach(room, () => ({ t: 'sfx', s: 'end' })); }, Math.max(0, q.endsAt - now()));
}

function closeQuestion(room, q, broadcast = true) {
  if (!q || q.closed) return;
  q.closed = true; q.endsAt = null;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (broadcast) scheduleState(room);
}

function removePlayer(room, pid, ban) {
  const p = room.players.get(pid); if (!p) return;
  for (const ws of p.sockets) { if (ban) send(ws, { t: 'kicked' }); ws.viewer = { role: 'none' }; ws.close(4001, 'kicked'); }
  if (ban) room.banned.add(p.token);
  room.tokens.delete(p.token);
  room.players.delete(pid);
  const c = room.chars.get(pid);
  if (c) {
    room.chars.delete(pid);
    room.order = room.order.filter(id => id !== c.id);
    room.unmasked = room.unmasked.filter(id => id !== c.id);
    const removed = room.messages.filter(m => m.ownerId === pid).map(m => m.id);
    room.messages = room.messages.filter(m => m.ownerId !== pid);
    for (const id of removed) broadcastEach(room, () => ({ t: 'msgDel', id }));
    for (const [v, cid] of room.votes) if (cid === c.id) { room.votes.delete(v); room.voteNames.delete(v); }
    room.elimHits = room.elimHits.filter(h => h.charId !== c.id && h.pid !== pid);
    for (const g of room.guesses.values()) delete g[c.id];
  }
  room.votes.delete(pid); room.voteNames.delete(pid); room.guesses.delete(pid);
  for (const q of room.questions) q.answered.delete(pid);
  scheduleState(room);
}

function toggleReact(map, key, emoji, pid) {
  if (!EMOJIS.includes(emoji)) return false;
  if (!map.has(key)) map.set(key, new Map());
  const m = map.get(key);
  if (!m.has(emoji)) m.set(emoji, new Set());
  const set = m.get(emoji);
  set.has(pid) ? set.delete(pid) : set.add(pid);
  return true;
}

function validImgUrl(room, u) {
  if (typeof u !== 'string') return null;
  const m = /^\/img\/([A-Z0-9]{5})\/([A-Za-z0-9_-]{10,40})$/.exec(u);
  return m && m[1] === room.code && room.images.has(m[2]) ? u : null;
}
function validAvatar(room, a) {
  if (typeof a !== 'string') return null;
  if (/^p:\d{1,2}$/.test(a)) return a;
  return validImgUrl(room, a);
}

// ---------- رسائل المضيف ----------
function onHost(room, ws, d) {
  switch (d.t) {
    case 'phase': {
      const ph = d.phase === 'next' ? PHASES[PHASES.indexOf(room.phase) + 1] : d.phase === 'prev' ? PHASES[PHASES.indexOf(room.phase) - 1] : d.phase;
      if (ph) setPhase(room, ph);
      break;
    }
    case 'flip': {
      if (room.phase !== 'reveal' || !room.order.includes(d.charId) || room.revealed.has(d.charId)) return;
      room.revealed.add(d.charId);
      const c = charById(room, d.charId);
      broadcastEach(room, () => ({ t: 'flip', card: { ...publicChar(c), open: true, reacts: {}, mine: [] } }));
      scheduleState(room);
      break;
    }
    case 'flipAll': {
      if (room.phase !== 'reveal') return;
      for (const id of room.order) room.revealed.add(id);
      broadcastEach(room, () => ({ t: 'flipAll' }));
      scheduleState(room);
      break;
    }
    case 'ask': {
      if (PHASES.indexOf(room.phase) < 2) return send(ws, { t: 'toast', text: 'الأسئلة تبدأ بعد صناعة الشخصيات' });
      if (room.phase !== 'chat') setPhase(room, 'chat');
      const text = clip(d.text, 300); if (!text) return;
      const prev = curQ(room); if (isOpenQ(prev)) closeQuestion(room, prev, false);
      const secs = Math.max(0, Math.min(600, parseInt(d.timer, 10) || 0));
      const q = { id: rid(6), text, ts: now(), closed: false, endsAt: secs ? now() + secs * 1000 : null, answered: new Set() };
      room.questions.push(q);
      armTimer(room, q);
      if (Number.isInteger(d.bankIndex) && room.bank[d.bankIndex] === text) room.bank.splice(d.bankIndex, 1);
      broadcastEach(room, () => ({ t: 'question', q: questionView(q) }));
      scheduleState(room);
      break;
    }
    case 'reopenQ': {
      if (room.phase !== 'chat') return; const q = curQ(room); if (!q || !q.closed) return;
      const secs = Math.max(0, Math.min(600, parseInt(d.timer, 10) || 0));
      q.closed = false; q.endsAt = secs ? now() + secs * 1000 : null; armTimer(room, q);
      scheduleState(room); break;
    }
    case 'extendQ': {
      const q = curQ(room); if (!isOpenQ(q)) return;
      const secs = Math.max(-600, Math.min(600, parseInt(d.secs, 10) || 0));
      if (d.clear) q.endsAt = null; else q.endsAt = Math.max(now() + 3000, (q.endsAt || now()) + secs * 1000);
      armTimer(room, q); scheduleState(room); break;
    }
    case 'editQ': {
      const q = curQ(room); const text = clip(d.text, 300); if (!q || !text) return;
      q.text = text; broadcastEach(room, () => ({ t: 'qEdit', id: q.id, text })); scheduleState(room); break;
    }
    case 'bankAdd': {
      const lines = String(d.text || '').split('\n').map(x => clip(x, 300)).filter(Boolean).slice(0, 50);
      room.bank.push(...lines); room.bank = room.bank.slice(0, 200); scheduleState(room); break;
    }
    case 'bankDel': { if (Number.isInteger(d.i)) room.bank.splice(d.i, 1); scheduleState(room); break; }
    case 'lock': {
      if (d.what === 'vote') room.voteLocked = !!d.locked;
      if (d.what === 'guess') room.guessLocked = !!d.locked;
      scheduleState(room); break;
    }
    case 'resetVotes': { if (d.what === 'vote') { room.votes.clear(); room.voteNames.clear(); } if (d.what === 'guess') room.guesses.clear(); scheduleState(room); break; }
    case 'settings': {
      const st = room.settings;
      if (Array.isArray(d.names)) st.names = [...new Set(d.names.map(n => clip(n, 24)).filter(Boolean))].slice(0, 100);
      if (typeof d.pickName === 'boolean') st.pickName = d.pickName;
      if (typeof d.lateJoin === 'boolean') st.lateJoin = d.lateJoin;
      if (typeof d.showAnswered === 'boolean') st.showAnswered = d.showAnswered;
      if (typeof d.elimMode === 'boolean') st.elimMode = d.elimMode;
      scheduleState(room); break;
    }
    case 'eliminate': {
      if (d.top) {
        // ينقصى كل شخصية خمّن أحد صاحبها صح في هذي الجولة (مو الأكثر أصوات)
        const hits = new Map(); // charId -> [pid]
        for (const [v, cid] of room.votes) {
          if (!canVote(room, v) || room.eliminated.has(cid)) continue;
          const c = charById(room, cid); if (!c || c.ownerId === v) continue;
          if (room.voteNames.get(v) === room.players.get(c.ownerId)?.name) { if (!hits.has(cid)) hits.set(cid, []); hits.get(cid).push(v); }
        }
        if (!room.votes.size) return send(ws, { t: 'toast', text: 'ما فيه أصوات للحين' });
        if (!hits.size) return send(ws, { t: 'toast', text: 'محد خمّن صح هالجولة، ما أحد يطلع 🎭' });
        let alive = room.order.length - room.eliminated.size;
        const outNow = [];
        for (const [cid, pids] of hits) {
          if (alive <= 1) break;
          room.eliminated.set(cid, room.round); alive--; outNow.push(cid);
          for (const v of pids) if (!room.elimHits.some(h => h.pid === v && h.charId === cid)) room.elimHits.push({ pid: v, charId: cid, round: room.round });
        }
        for (const cid of outNow) { const o = charById(room, cid)?.ownerId; if (o) { room.votes.delete(o); room.voteNames.delete(o); } }
        broadcastEach(room, () => ({ t: 'sfx', s: 'unmask' }));
        send(ws, { t: 'toast', text: `🎯 انكشفت ${outNow.length} ${outNow.length === 1 ? 'شخصية' : 'شخصيات'} بالتخمين الصحيح` });
        scheduleState(room); break;
      }
      if (!room.order.includes(d.charId)) return;
      if (d.restore) { room.eliminated.delete(d.charId); room.elimHits = room.elimHits.filter(h => !(h.charId === d.charId && h.round === room.round)); }
      else {
        if (room.eliminated.has(d.charId)) return;
        if (room.order.length - room.eliminated.size <= 1) return send(ws, { t: 'toast', text: 'باقي شخصية وحدة، ما ينفع تقصيها' });
        room.eliminated.set(d.charId, room.round);
        const o = charById(room, d.charId)?.ownerId; if (o) { room.votes.delete(o); room.voteNames.delete(o); } // اللي طلع ما يصوّت
        broadcastEach(room, () => ({ t: 'sfx', s: 'unmask' }));
      }
      scheduleState(room); break;
    }
    case 'newRound': {
      // نحفظ أصوات هذي الجولة ونرجع للمحادثة بنفس الشخصيات والرسائل
      if (room.phase !== 'vote') return;
      const tally = {}; for (const [v, cid] of room.votes) if (canVote(room, v)) tally[cid] = (tally[cid] || 0) + 1;
      room.pastVotes.push(tally); room.votes.clear(); room.voteNames.clear(); room.voteLocked = false; room.round++;
      setPhase(room, 'chat');
      break;
    }
    case 'unban': { room.banned.clear(); send(ws, { t: 'toast', text: 'تم السماح للمطرودين بالدخول من جديد' }); break; }
    case 'closeQ': { const q = curQ(room); if (isOpenQ(q)) { closeQuestion(room, q); } break; }
    case 'delMsg': {
      const i = room.messages.findIndex(m => m.id === d.id); if (i < 0) return;
      const [m] = room.messages.splice(i, 1);
      const q = room.questions.find(x => x.id === m.qid);
      if (q && !room.messages.some(x => x.qid === q.id && x.ownerId === m.ownerId)) q.answered.delete(m.ownerId);
      broadcastEach(room, () => ({ t: 'msgDel', id: m.id }));
      scheduleState(room);
      break;
    }
    case 'kick': removePlayer(room, d.pid, true); break;
    case 'unmask': {
      if (room.phase !== 'results') return;
      const cid = d.charId || room.order.find(id => !room.unmasked.includes(id));
      if (!cid || !room.order.includes(cid) || room.unmasked.includes(cid)) return;
      room.unmasked.push(cid);
      broadcastEach(room, () => ({ t: 'sfx', s: 'unmask', charId: cid }));
      scheduleState(room);
      break;
    }
    case 'board': {
      if (room.phase !== 'results') return;
      for (const id of room.order) if (!room.unmasked.includes(id)) room.unmasked.push(id);
      room.showBoard = true;
      broadcastEach(room, () => ({ t: 'sfx', s: 'board' }));
      scheduleState(room);
      break;
    }
    case 'restart': {
      if (room.timer) clearTimeout(room.timer);
      room.timer = null;
      freshGame(room);
      room.images.clear(); room.imgBytes = 0;
      for (const ws of viewers(room)) { send(ws, { t: 'restart' }); send(ws, snapshot(room, ws.viewer)); }
      break;
    }
  }
}

// ---------- رسائل اللاعب ----------
function onPlayer(room, ws, d) {
  const pid = ws.viewer.pid; const ph = room.phase;
  switch (d.t) {
    case 'char': {
      if (ph !== 'create' && ph !== 'lobby') return send(ws, { t: 'toast', text: 'انتهى وقت صناعة الشخصيات' });
      let c = room.chars.get(pid);
      if (!c) { c = { id: rid(8), ownerId: pid, name: '', bio: '', tagline: '', avatar: 'p:0', done: false }; room.chars.set(pid, c); }
      c.name = clip(d.name, 30); c.bio = clip(d.bio, 300); c.tagline = clip(d.tagline, 60);
      c.avatar = validAvatar(room, d.avatar) || 'p:0';
      c.done = !!d.done && !!c.name;
      scheduleState(room);
      break;
    }
    case 'leave': { send(ws, { t: 'left' }); removePlayer(room, pid, false); break; }
    case 'msg': {
      if (ph !== 'chat') return;
      const c = room.chars.get(pid); if (!c || !c.done || !room.order.includes(c.id)) return send(ws, { t: 'toast', text: 'ما عندك شخصية في هذي الجولة' });
      if (room.eliminated.has(c.id)) return send(ws, { t: 'toast', text: '🚫 شخصيتك انقصت، تقدر تتابع وتتفاعل بس' });
      const q = curQ(room); if (!isOpenQ(q)) return send(ws, { t: 'toast', text: 'السؤال مقفل، انتظر السؤال الجاي' });
      const text = clip(d.text, 500); const img = validImgUrl(room, d.img);
      if (!text && !img) return;
      ws.lastMsg = ws.lastMsg || 0; if (now() - ws.lastMsg < 600) return; ws.lastMsg = now();
      const m = { id: rid(8), qid: q.id, charId: c.id, ownerId: pid, text, img, ts: now() };
      room.messages.push(m);
      if (room.messages.length > 2000) room.msgReacts.delete(room.messages.shift().id);
      q.answered.add(pid);
      broadcastEach(room, v => ({ t: 'msg', m: msgView(room, m, v.pid) }));
      scheduleState(room);
      break;
    }
    case 'msgReact': {
      const m = room.messages.find(x => x.id === d.id); if (!m) return;
      if (!toggleReact(room.msgReacts, m.id, d.emoji, pid)) return;
      const map = room.msgReacts.get(m.id);
      broadcastEach(room, v => { const r = reactCounts(map, v.pid); return { t: 'msgReact', id: m.id, reacts: r.counts, mine: r.mine }; });
      break;
    }
    case 'cardReact': {
      if (!room.order.includes(d.charId)) return;
      if (ph === 'reveal' && !room.revealed.has(d.charId)) return;
      if (!toggleReact(room.cardReacts, d.charId, d.emoji, pid)) return;
      const map = room.cardReacts.get(d.charId);
      broadcastEach(room, v => { const r = reactCounts(map, v.pid); return { t: 'cardReact', charId: d.charId, reacts: r.counts, mine: r.mine }; });
      break;
    }
    case 'vote': {
      if (ph !== 'vote') return;
      if (room.voteLocked) return send(ws, { t: 'toast', text: 'التصويت مقفل 🔒' });
      if (isOut(room, pid)) return send(ws, { t: 'toast', text: '🚪 طلعت من اللعبة، ما تقدر تصوّت' });
      const mine = room.chars.get(pid);
      if (!room.order.includes(d.charId)) return;
      if (room.eliminated.has(d.charId)) return send(ws, { t: 'toast', text: 'هذي الشخصية انقصت' });
      if (mine && mine.id === d.charId) return send(ws, { t: 'toast', text: 'ما تقدر تصوّت لشخصيتك 😏' });
      if (room.settings.elimMode) {
        const nm = typeof d.name === 'string' ? d.name : '';
        if (!new Set(guessNames(room)).has(nm) || nm === room.players.get(pid)?.name) return send(ws, { t: 'toast', text: 'اختار مين تتوقع صاحبها' });
        room.voteNames.set(pid, nm);
      } else room.voteNames.delete(pid);
      room.votes.set(pid, d.charId);
      scheduleState(room);
      break;
    }
    case 'guess': {
      if (ph !== 'guess' || !d.guesses || typeof d.guesses !== 'object') return;
      if (room.guessLocked) return send(ws, { t: 'toast', text: 'التخمين مقفل 🔒' });
      const allowed = new Set(guessNames(room)); const mine = room.chars.get(pid); const myName = room.players.get(pid)?.name;
      const g = {};
      for (const [cid, owner] of Object.entries(d.guesses)) {
        if (!room.order.includes(cid) || room.eliminated.has(cid) || (mine && mine.id === cid)) continue;
        if (typeof owner === 'string' && allowed.has(owner) && owner !== myName) g[cid] = owner;
      }
      room.guesses.set(pid, g);
      scheduleState(room);
      break;
    }
  }
}


// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

function imageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/rooms' && req.method === 'POST') {
      const room = createRoom();
      return json(res, 200, { code: room.code, token: room.hostToken });
    }
    if (p === '/api/room' && req.method === 'GET') {
      const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
      return json(res, 200, room ? { ok: true, phase: room.phase, open: room.settings.lateJoin || ['lobby', 'create'].includes(room.phase), count: room.players.size, max: MAX_PLAYERS, names: room.settings.pickName ? room.settings.names : [], taken: takenNames(room) } : { ok: false });
    }
    if (p === '/api/qr') {
      const text = clip(url.searchParams.get('text'), 300);
      const svg = await QRCode.toString(text || ' ', { type: 'svg', margin: 1, color: { dark: '#0b1030', light: '#ffffff' }, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
      return res.end(svg);
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const room = rooms.get(url.searchParams.get('code'));
      const pid = room && room.tokens.get(url.searchParams.get('token'));
      if (!room || !pid) return json(res, 403, { error: 'غير مصرّح' });
      const chunks = []; let size = 0;
      for await (const ch of req) { size += ch.length; if (size > MAX_IMG_BYTES) return json(res, 413, { error: 'الصورة كبيرة' }); chunks.push(ch); }
      const buf = Buffer.concat(chunks);
      const type = imageType(buf); if (!type) return json(res, 415, { error: 'نوع غير مدعوم' });
      if (room.imgBytes + buf.length > MAX_ROOM_IMG_BYTES) return json(res, 507, { error: 'امتلأت مساحة الغرفة' });
      const id = rid(16);
      room.images.set(id, { buf, type }); room.imgBytes += buf.length; room.lastActive = now();
      return json(res, 200, { url: `/img/${room.code}/${id}` });
    }
    let m;
    if ((m = /^\/img\/([A-Z0-9]{5})\/([A-Za-z0-9_-]+)$/.exec(p))) {
      const img = rooms.get(m[1])?.images.get(m[2]);
      if (!img) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400, immutable', 'Content-Length': img.buf.length });
      return res.end(img.buf);
    }
    if (p === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    // ملفات ثابتة
    let file = p === '/' || /^\/[A-Z0-9]{5}$/.test(p) ? '/index.html' : p;
    file = path.normalize(path.join(PUBLIC, file));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
      res.end(data);
    });
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: 'خطأ' }); }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.viewer = { role: 'none' }; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d.t !== 'string') return;
    if (ws.viewer.role === 'none') return handshake(ws, d);
    const room = rooms.get(ws.viewer.code); if (!room) return send(ws, { t: 'gone' });
    room.lastActive = now();
    if (d.t === 'ping') return send(ws, { t: 'pong' });
    if (ws.viewer.role === 'host') onHost(room, ws, d);       // صلاحيات المضيف: فقط الجلسة المصادَق عليها برمز المضيف
    else if (ws.viewer.role === 'player') onPlayer(room, ws, d);
  });
  ws.on('close', () => {
    const v = ws.viewer; const room = v.code && rooms.get(v.code); if (!room) return;
    if (v.role === 'host') room.hostSockets.delete(ws);
    else if (v.role === 'player') room.players.get(v.pid)?.sockets.delete(ws);
    scheduleState(room);
  });
});

function attach(room, ws, viewer) {
  ws.viewer = { ...viewer, code: room.code };
  if (viewer.role === 'host') room.hostSockets.add(ws); else room.players.get(viewer.pid).sockets.add(ws);
  send(ws, { t: 'welcome', role: viewer.role, code: room.code, token: viewer.token, pid: viewer.pid || null });
  send(ws, snapshot(room, ws.viewer));
  if (PHASES.indexOf(room.phase) >= 3) sendHistory(room, ws);
  scheduleState(room);
}

function handshake(ws, d) {
  const code = String(d.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'error', code: 'noroom', text: 'الغرفة غير موجودة أو انتهت' });
  room.lastActive = now();
  if (d.t === 'resume') {
    if (d.token && d.token === room.hostToken) return attach(room, ws, { role: 'host', token: d.token });
    const pid = room.tokens.get(d.token);
    if (pid) return attach(room, ws, { role: 'player', pid, token: d.token });
    if (room.banned.has(d.token)) return send(ws, { t: 'kicked' });
    return send(ws, { t: 'error', code: 'notoken', text: 'انتهت جلستك، ادخل من جديد' });
  }
  if (d.t === 'join') {
    const name = clip(d.name, 24);
    if (!name) return send(ws, { t: 'error', code: 'name', text: 'اكتب اسمك' });
    if (!room.settings.lateJoin && !['lobby', 'create'].includes(room.phase)) return send(ws, { t: 'error', code: 'started', text: 'اللعبة بدأت، ما يمديك تدخل الحين' });
    if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', code: 'full', text: 'الغرفة مكتملة (30 لاعب)' });
    if ([...room.players.values()].some(p => p.name === name)) return send(ws, { t: 'error', code: 'taken', text: 'هذا الاسم مستخدم، زد عليه حرف' });
    const pid = rid(8), token = rid(18);
    room.players.set(pid, { id: pid, token, name, sockets: new Set(), joinedAt: now() });
    room.tokens.set(token, pid);
    return attach(room, ws, { role: 'player', pid, token });
  }
}

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  const t = now();
  for (const [code, room] of rooms) if (t - room.lastActive > ROOM_TTL_MS && viewers(room).length === 0) { if (room.timer) clearTimeout(room.timer); rooms.delete(code); }
}, 25000);

server.listen(PORT, () => console.log(`«أقنعة» شغالة على http://localhost:${PORT}`));
module.exports = { server, rooms };
