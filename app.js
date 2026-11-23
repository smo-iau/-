'use strict';
/* «أقنعة» — واجهة اللعبة */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');

  const PHASES = ['lobby', 'create', 'reveal', 'chat', 'vote', 'guess', 'results'];
  const PHASE_NAMES = { lobby: 'الانتظار', create: 'صناعة الشخصية', reveal: 'الكشف', chat: 'المحادثة', vote: 'التصويت', guess: 'التخمين', results: 'النتائج' };
  const PRESETS = [
    ['🎭', '#6b3fd9', '#e7c36a'], ['🦊', '#d9622b', '#ffc36b'], ['🐺', '#334a8c', '#9fb5ff'], ['🦉', '#5a3d2b', '#e7c36a'],
    ['🐱', '#c94f8a', '#ffc1e0'], ['🦁', '#c98a1f', '#ffe08a'], ['🐼', '#2b2f45', '#e9ecff'], ['👑', '#7a1f4f', '#ffd36b'],
    ['🌙', '#1d2b6b', '#b9c6ff'], ['🃏', '#1f6b5a', '#9ff0d0'], ['🕵️', '#22253a', '#a8a3c7'], ['👻', '#4b2d8c', '#d9c6ff'],
    ['🐙', '#8c2d5a', '#ff9fc8'], ['🦄', '#5d2d8c', '#ffb8f0'], ['🤖', '#2d5f8c', '#9fe0ff'], ['🐸', '#2d8c4a', '#c8ff9f'],
  ];

  // ---------- الحالة ----------
  let S = null;             // آخر لقطة من الخادم
  let ws = null, wsOpen = false, retry = 0, retryTimer = null;
  let session = null;       // {code, token, role}
  let hist = { questions: [], messages: [] };
  let screenKey = '';
  let clockOff = 0;
  const charCache = new Map();
  const seen = { flipped: new Set(), unmasked: new Set(), board: false, out: null };
  let spotlightId = null;
  let draft = null;         // مسودة الشخصية
  let pendingImg = null;    // صورة مرفقة للرسالة {url, blob}
  let muted = false;
  try { muted = localStorage.getItem('aqnia.muted') === '1'; } catch {}

  const store = {
    get() { try { return JSON.parse(localStorage.getItem('aqnia.session') || 'null'); } catch { return null; } },
    set(v) { try { localStorage.setItem('aqnia.session', JSON.stringify(v)); } catch {} },
    clear() { try { localStorage.removeItem('aqnia.session'); } catch {} },
  };

  const isHost = () => S && S.you.role === 'host';
  const serverNow = () => Date.now() + clockOff;
  const joinLink = (code) => `${location.origin}/${code}`;

  // ---------- الأصوات (WebAudio بدون ملفات) ----------
  let actx = null;
  function ac() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } } if (actx.state === 'suspended') actx.resume(); return actx; }
  function tone(freq, dur, { type = 'sine', vol = .12, delay = 0, slide = 0 } = {}) {
    const c = ac(); if (!c) return;
    const t = c.currentTime + delay; const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + .05);
  }
  function whoosh() {
    const c = ac(); if (!c) return;
    const len = c.sampleRate * .5; const b = c.createBuffer(1, len, c.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource(); s.buffer = b; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(400, c.currentTime); f.frequency.exponentialRampToValueAtTime(3000, c.currentTime + .4);
    const g = c.createGain(); g.gain.value = .18; s.connect(f).connect(g).connect(c.destination); s.start();
  }
  const SFX = {
    flip() { whoosh(); tone(660, .5, { delay: .25, vol: .1 }); tone(990, .6, { delay: .35, vol: .07 }); },
    pop() { tone(880, .12, { type: 'triangle', vol: .06, slide: 1.4 }); },
    react() { tone(1200, .08, { type: 'triangle', vol: .05 }); },
    question() { tone(523, .25, { vol: .09 }); tone(784, .35, { delay: .12, vol: .09 }); },
    end() { tone(440, .3, { type: 'square', vol: .04 }); tone(330, .4, { type: 'square', vol: .04, delay: .2 }); },
    unmask() { whoosh(); [523, 659, 784, 1046].forEach((f, i) => tone(f, .5, { delay: .3 + i * .09, vol: .08 })); },
    board() { [392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, .6, { delay: i * .1, vol: .08, type: 'triangle' })); },
    join() { tone(740, .15, { vol: .05 }); },
  };
  function sfx(n) { if (!muted && SFX[n]) try { SFX[n](); } catch {} }
  function setMuteIcon() { $('#muteBtn').textContent = muted ? '🔇' : '🔊'; $('#muteBtn').setAttribute('aria-label', muted ? 'تشغيل الصوت' : 'كتم الصوت'); }
  $('#muteBtn').onclick = () => { muted = !muted; try { localStorage.setItem('aqnia.muted', muted ? '1' : '0'); } catch {} setMuteIcon(); if (!muted) sfx('pop'); };
  setMuteIcon();
  document.addEventListener('pointerdown', () => ac(), { once: true });

  // ---------- كونفيتي ----------
  const cv = $('#confetti'); const cx = cv.getContext('2d'); let parts = []; let confRAF = 0;
  function confetti(n = 160) {
    const dpr = devicePixelRatio || 1; cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cols = ['#e7c36a', '#f6dc94', '#9b6bff', '#c3a6ff', '#ffffff', '#ff7ab6'];
    for (let i = 0; i < n; i++) parts.push({ x: innerWidth / 2 + (Math.random() - .5) * innerWidth * .6, y: innerHeight * .35, vx: (Math.random() - .5) * 12, vy: -Math.random() * 14 - 4, w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: cols[i % cols.length], life: 0 });
    if (!confRAF) loop();
    function loop() {
      cx.clearRect(0, 0, innerWidth, innerHeight);
      parts = parts.filter(p => p.y < innerHeight + 40 && p.life < 400);
      for (const p of parts) { p.life++; p.vy += .32; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr; cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.fillStyle = p.c; cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life / 8))); cx.restore(); }
      confRAF = parts.length ? requestAnimationFrame(loop) : 0;
      if (!confRAF) cx.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  // ---------- أدوات الواجهة ----------
  let toastT;
  function toast(text) { const t = $('#toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

  function avatar(a, size = 48) {
    let inner;
    if (typeof a === 'string' && a.startsWith('/img/')) inner = `<img src="${esc(a)}" alt="" loading="lazy">`;
    else {
      const i = Math.max(0, Math.min(PRESETS.length - 1, parseInt(String(a || 'p:0').slice(2), 10) || 0));
      const [e, c1, c2] = PRESETS[i];
      return `<div class="av" style="--s:${size}px;background:radial-gradient(circle at 30% 25%, ${c2}, ${c1} 70%)">${e}</div>`;
    }
    return `<div class="av" style="--s:${size}px">${inner}</div>`;
  }

  function modal(html, { cls = '', onClose } = {}) {
    const root = $('#modalRoot'); const m = document.createElement('div');
    m.className = 'modal ' + cls; m.innerHTML = html; root.appendChild(m);
    const close = () => { m.remove(); onClose && onClose(); };
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); });
    return { el: m, close };
  }
  function confirmBox(text, okText = 'تأكيد', danger = false) {
    return new Promise(res => {
      const m = modal(`<div class="sheet"><h3>${esc(text)}</h3><div class="row" style="margin-top:16px"><button class="btn ${danger ? 'btn-danger' : 'btn-gold'} grow" data-ok>${esc(okText)}</button><button class="btn btn-ghost grow" data-close>إلغاء</button></div></div>`, { onClose: () => res(false) });
      $('[data-ok]', m.el).onclick = () => { m.el.remove(); res(true); };
    });
  }
  function lightbox(src) { modal(`<img src="${esc(src)}" alt=""><button class="icon-btn close" data-close aria-label="إغلاق">✕</button>`, { cls: 'lightbox' }); }

  function emojiPicker(onPick) {
    const list = (S && S.emojis) || ['😂', '😮', '🔥', '❤️', '🤔', '👏', '😱', '🕵️'];
    const m = modal(`<div class="sheet"><div class="sheet-head"><h3>تفاعل</h3><button class="icon-btn" data-close>✕</button></div><div class="emoji-pop">${list.map(e => `<button data-e="${e}">${e}</button>`).join('')}</div></div>`);
    $$('[data-e]', m.el).forEach(b => b.onclick = () => { onPick(b.dataset.e); m.close(); });
  }

  function reactsHTML(reacts = {}, mine = [], { all = false } = {}) {
    const list = (S && S.emojis) || [];
    const keys = all ? list : list.filter(e => reacts[e]);
    return keys.map(e => `<button class="react-btn ${mine.includes(e) ? 'on' : ''}" data-react="${e}">${e}${reacts[e] ? `<small>${reacts[e]}</small>` : ''}</button>`).join('');
  }

  // ---------- الصور: قص وضغط ورفع ----------
  function pickFile({ camera = false } = {}) {
    return new Promise(res => {
      const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
      if (camera) i.setAttribute('capture', 'user');
      i.onchange = () => res(i.files && i.files[0] || null);
      i.click();
    });
  }
  function loadImage(file) {
    return new Promise((res, rej) => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => res(im); im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('img')); }; im.src = u; });
  }
  function canvasBlob(c, q) { return new Promise(r => c.toBlob(r, 'image/jpeg', q)); }
  async function compress(file, max = 1280) {
    const im = await loadImage(file);
    let w = im.naturalWidth, h = im.naturalHeight; const k = Math.min(1, max / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(im, 0, 0, w, h);
    let q = .82, b = await canvasBlob(c, q);
    while (b && b.size > 900 * 1024 && q > .4) { q -= .12; b = await canvasBlob(c, q); }
    URL.revokeObjectURL(im.src);
    return b;
  }
  async function upload(blob) {
    const r = await fetch(`/api/upload?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'فشل الرفع');
    return j.url;
  }

  function cropper(file) {
    return new Promise(async (resolve) => {
      let im; try { im = await loadImage(file); } catch { toast('ما قدرنا نفتح الصورة'); return resolve(null); }
      const m = modal(`<div class="sheet"><div class="sheet-head"><h3>قص الصورة</h3><button class="icon-btn" data-close>✕</button></div>
        <div class="crop-area"><canvas></canvas></div>
        <p class="small muted center" style="margin:8px 0 0">اسحب الصورة لتحريكها، وكبّر بالإصبعين أو بالشريط</p>
        <input type="range" min="1" max="4" step="0.01" value="1" aria-label="تكبير">
        <button class="btn btn-gold btn-block" data-ok>اعتمد الصورة</button></div>`, { onClose: () => resolve(null) });
      const area = $('.crop-area', m.el), c = $('canvas', m.el), range = $('input[type=range]', m.el), g = c.getContext('2d');
      const dpr = devicePixelRatio || 1; const V = area.clientWidth; c.width = V * dpr; c.height = V * dpr;
      const base = Math.max(V / im.naturalWidth, V / im.naturalHeight);
      let z = 1, ox = 0, oy = 0; // إزاحة المركز
      const clamp = () => { const s = base * z; const mx = Math.max(0, (im.naturalWidth * s - V) / 2), my = Math.max(0, (im.naturalHeight * s - V) / 2); ox = Math.max(-mx, Math.min(mx, ox)); oy = Math.max(-my, Math.min(my, oy)); };
      const draw = () => { clamp(); const s = base * z; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, V, V); g.drawImage(im, V / 2 - im.naturalWidth * s / 2 + ox, V / 2 - im.naturalHeight * s / 2 + oy, im.naturalWidth * s, im.naturalHeight * s); };
      draw();
      const pts = new Map(); let pinch0 = 0, z0 = 1;
      area.addEventListener('pointerdown', e => { area.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); z0 = z; } });
      area.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId)) return; const p = pts.get(e.pointerId);
        if (pts.size === 1) { ox += e.clientX - p.x; oy += e.clientY - p.y; }
        p.x = e.clientX; p.y = e.clientY;
        if (pts.size === 2) { const [a, b] = [...pts.values()]; z = Math.max(1, Math.min(4, z0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch0)); range.value = z; }
        draw();
      });
      const up = e => pts.delete(e.pointerId); area.addEventListener('pointerup', up); area.addEventListener('pointercancel', up);
      area.addEventListener('wheel', e => { e.preventDefault(); z = Math.max(1, Math.min(4, z - e.deltaY * .002)); range.value = z; draw(); }, { passive: false });
      range.oninput = () => { z = +range.value; draw(); };
      $('[data-ok]', m.el).onclick = async () => {
        const O = 512, k = O / V, s = base * z; const out = document.createElement('canvas'); out.width = O; out.height = O;
        const og = out.getContext('2d'); og.fillStyle = '#000'; og.fillRect(0, 0, O, O);
        og.drawImage(im, (V / 2 - im.naturalWidth * s / 2 + ox) * k, (V / 2 - im.naturalHeight * s / 2 + oy) * k, im.naturalWidth * s * k, im.naturalHeight * s * k);
        const b = await canvasBlob(out, .85); URL.revokeObjectURL(im.src); m.el.remove(); resolve(b);
      };
    });
  }

  // ---------- الاتصال ----------
  function connect() {
    clearTimeout(retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { wsOpen = true; retry = 0; $('#netBanner').classList.add('hidden'); if (session) wsSend({ t: 'resume', code: session.code, token: session.token }); else if (pendingJoin) wsSend(pendingJoin); };
    ws.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch { return; } onServer(d); };
    ws.onclose = () => {
      wsOpen = false;
      if (!session && !pendingJoin) return;
      $('#netBanner').classList.remove('hidden');
      retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
  }
  function wsSend(o) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } toast('غير متصل… نحاول نرجع'); return false; }
  let pendingJoin = null;
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session && (!ws || ws.readyState > 1)) connect(); });
  addEventListener('online', () => { if (session && (!ws || ws.readyState > 1)) connect(); });
  setInterval(() => { if (wsOpen) wsSend({ t: 'ping' }); }, 20000);

  function onServer(d) {
    switch (d.t) {
      case 'welcome':
        session = { code: d.code, token: d.token, role: d.role }; pendingJoin = null; store.set(session);
        if (location.pathname !== '/' + d.code) history.replaceState(null, '', '/' + d.code);
        break;
      case 'state': {
        const prev = S; S = d; clockOff = d.serverNow - Date.now();
        (d.cards || []).forEach(c => { if (c.open) charCache.set(c.id, c); });
        if (prev && prev.players && d.players.length > prev.players.length && d.phase === 'lobby') sfx('join');
        render();
        checkElim(d);
        break;
      }
      case 'history': hist = { questions: d.questions, messages: d.messages }; if (screenKey === 'chat') renderChatList(); break;
      case 'question': hist.questions.push(d.q); sfx('question'); if (screenKey === 'chat') { appendItem({ kind: 'q', ...d.q }); } break;
      case 'msg': {
        hist.messages.push(d.m); if (screenKey === 'chat') appendItem({ kind: 'm', ...d.m }, true); if (!d.m.own) sfx('pop');
        break;
      }
      case 'msgDel': hist.messages = hist.messages.filter(m => m.id !== d.id); $(`[data-mid="${d.id}"]`)?.remove(); break;
      case 'msgReact': {
        const m = hist.messages.find(x => x.id === d.id); if (m) { m.reacts = d.reacts; m.mine = d.mine; }
        const el = $(`[data-mid="${d.id}"] .msg-foot .rx`); if (el) el.innerHTML = reactsHTML(d.reacts, d.mine);
        break;
      }
      case 'cardReact': {
        const c = S && S.cards && S.cards.find(x => x.id === d.charId); if (c) { c.reacts = d.reacts; c.mine = d.mine; }
        updateCardReacts(d.charId);
        break;
      }
      case 'flip': charCache.set(d.card.id, d.card); spotlightId = d.card.id; sfx('flip'); break;
      case 'flipAll': sfx('flip'); break;
      case 'sfx': sfx(d.s); break;
      case 'restart': hist = { questions: [], messages: [] }; seen.flipped.clear(); seen.unmasked.clear(); seen.board = false; spotlightId = null; draft = null; charCache.clear(); toast('بدأت جولة جديدة 🎭'); break;
      case 'toast': toast(d.text); break;
      case 'left': session = null; store.clear(); S = null; showMessage('👋', 'طلعت من الغرفة', 'تقدر ترجع تدخل بالرابط متى ما بغيت.'); break;
      case 'qEdit': { const q = hist.questions.find(x => x.id === d.id); if (q) q.text = d.text; const el = $(`[data-qid="${d.id}"]`); if (el) el.textContent = '❓ ' + d.text; break; }
      case 'kicked': session = null; store.clear(); S = null; showMessage('🚪', 'تم إخراجك من الغرفة', 'المضيف أخرجك من هذي اللعبة.'); break;
      case 'error':
        if (d.code === 'noroom' || d.code === 'notoken') { const code = session && session.code; session = null; store.clear(); S = null; if (d.code === 'notoken' && code) return renderJoin(code, d.text); return renderHome(d.text); }
        if (pendingJoin) { pendingJoin = null; $$('#joinBtn, [data-n]').forEach(b => { if (!b.textContent.includes('✓')) b.disabled = false; }); ws && ws.close(); }
        toast(d.text);
        break;
      case 'gone': session = null; store.clear(); renderHome('انتهت الغرفة'); break;
    }
  }

  // ---------- الشاشات خارج اللعبة ----------
  function chrome(show) {
    $('#top').classList.toggle('hidden', !show);
    $('#hostBar').classList.toggle('hidden', !(show && isHost()));
    document.body.classList.toggle('is-host', !!(show && isHost()));
  }
  function showMessage(icon, title, text) {
    screenKey = 'msg'; chrome(false);
    app.innerHTML = `<div class="hero"><div class="big-mask">${icon}</div><h2 style="margin-top:12px">${esc(title)}</h2><p>${esc(text)}</p></div><div class="panel"><button class="btn btn-gold btn-block" id="homeBtn">الرئيسية</button></div>`;
    $('#homeBtn').onclick = () => { history.replaceState(null, '', '/'); renderHome(); };
  }

  function renderHome(err) {
    screenKey = 'home'; chrome(false);
    app.innerHTML = `
      <section class="hero"><div class="big-mask">🎭</div><h1>أقنعة</h1>
        <p>سوّ شخصية وهمية، احكِ بلسانها مع أصحابك، وفي الأخير خمّنوا: مين ورا كل قناع؟</p></section>
      ${err ? `<div class="panel glass center" style="color:#ffb3bf">${esc(err)}</div>` : ''}
      <section class="panel glass stack">
        <h3>ادخل غرفة</h3>
        <input class="input code" id="codeIn" maxlength="5" placeholder="الرمز" autocomplete="off" inputmode="latin" aria-label="رمز الغرفة">
        <button class="btn btn-violet btn-block" id="goJoin">دخول</button>
        <div class="divider">أو</div>
        <button class="btn btn-gold btn-block" id="mkRoom">👑 أنشئ غرفة وكن المضيف</button>
      </section>
      <section class="panel"><div class="steps">
        <div><b>١. شخصية</b>اسم وهمي وصورة وسيرة</div><div><b>٢. الكشف</b>البطاقات تنقلب وحدة وحدة</div>
        <div><b>٣. حوار</b>جاوب أسئلة المضيف بلسان شخصيتك</div><div><b>٤. تصويت</b>أفضل شخصية</div>
        <div><b>٥. تخمين</b>مين صاحب كل قناع؟</div><div><b>٦. نزع الأقنعة</b>والنقاط ولقب سيد التمويه</div>
      </div></section>`;
    const ci = $('#codeIn');
    ci.oninput = () => { ci.value = ci.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
    const go = () => { const c = ci.value.trim(); if (c.length !== 5) return toast('الرمز خمس خانات'); history.pushState(null, '', '/' + c); renderJoin(c); };
    $('#goJoin').onclick = go; ci.onkeydown = e => { if (e.key === 'Enter') go(); };
    $('#mkRoom').onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await fetch('/api/rooms', { method: 'POST' }); const j = await r.json(); session = { code: j.code, token: j.token, role: 'host' }; store.set(session); history.replaceState(null, '', '/' + j.code); app.innerHTML = '<div class="spinner"></div>'; connect(); }
      catch { e.target.disabled = false; toast('تعذّر إنشاء الغرفة'); }
    };
  }

  async function renderJoin(code, err) {
    screenKey = 'join'; chrome(false);
    app.innerHTML = '<div class="spinner"></div>';
    let info = null; try { info = await (await fetch('/api/room?code=' + encodeURIComponent(code))).json(); } catch {}
    if (!info || !info.ok) return renderHome('ما لقينا غرفة بهذا الرمز: ' + code);
    app.innerHTML = `
      <section class="hero"><div class="big-mask">🎭</div><h1>أقنعة</h1><p>أنت مدعو لغرفة <b class="gold" style="letter-spacing:3px">${esc(code)}</b> · ${info.count} داخلين</p></section>
      ${err ? `<div class="panel glass center" style="color:#ffb3bf">${esc(err)}</div>` : ''}
      <section class="panel glass stack">
        ${info.open ? (info.names && info.names.length ? `<h3>مين أنت؟</h3><p class="small muted" style="margin:0">اختر اسمك من القائمة</p>
          <div class="names" id="namePick">${info.names.map(n => `<button class="name-chip pickable" data-n="${esc(n)}" ${info.taken.includes(n) ? 'disabled' : ''}>${esc(n)}${info.taken.includes(n) ? ' ✓' : ''}</button>`).join('')}</div>
          <details><summary class="small muted" style="cursor:pointer;padding:6px 0">اسمي مو موجود</summary><div class="stack" style="margin-top:8px"><input class="input" id="nameIn" maxlength="24" placeholder="اكتب اسمك" autocomplete="nickname"><button class="btn btn-violet btn-block" id="joinBtn">ادخل باسمي</button></div></details>`
        : `<label class="field"><span>اسمك الحقيقي (يشوفه الكل في القائمة فقط)</span><input class="input" id="nameIn" maxlength="24" placeholder="مثلًا: ماجد" autocomplete="nickname"></label>
        <button class="btn btn-gold btn-block" id="joinBtn">ادخل الغرفة</button>`) : `<p class="center">اللعبة بدأت، ما يمديك تدخل الحين. انتظر الجولة الجاية 🙏</p>`}
        <button class="btn btn-ghost btn-block" id="backHome">رجوع</button>
      </section>`;
    $('#backHome').onclick = () => { history.pushState(null, '', '/'); renderHome(); };
    const ni = $('#nameIn'); if (!ni) return;
    const doJoin = (name) => {
      $$('#joinBtn, [data-n]').forEach(b => b.disabled = true); pendingJoin = { t: 'join', code, name };
      if (ws && ws.readyState === 1) wsSend(pendingJoin); else connect();
    };
    $$('[data-n]').forEach(b => b.onclick = () => doJoin(b.dataset.n));
    if (!$('#namePick')) ni.focus();
    const join = () => { const name = ni.value.trim(); if (!name) return toast('اكتب اسمك'); doJoin(name); };
    $('#joinBtn').onclick = join; ni.onkeydown = e => { if (e.key === 'Enter') join(); };
  }

  // ---------- الإطار داخل اللعبة ----------
  function renderTop() {
    const online = S.players.filter(p => p.connected).length;
    $('#topMid').innerHTML = `<span class="pill">الغرفة <b>${esc(S.code)}</b></span><span class="pill"><i class="dot"></i>${online}</span>${isHost() ? '' : '<button class="pill" id="leaveBtn" style="cursor:pointer">🚪 خروج</button>'}`;
    const lb = $('#leaveBtn'); if (lb) lb.onclick = async () => { if (await confirmBox('تطلع من الغرفة؟ شخصيتك ورسائلك بتنحذف.', 'اطلع', true)) wsSend({ t: 'leave' }); };
    if (isHost()) {
      const i = PHASES.indexOf(S.phase);
      $('#hostBar').innerHTML = `
        <button class="btn btn-ghost" id="hbPrev" ${i === 0 ? 'disabled' : ''} aria-label="المرحلة السابقة">→</button>
        <div class="phase-name">${i + 1}. ${PHASE_NAMES[S.phase]}<small>${i < PHASES.length - 1 ? 'التالي: ' + PHASE_NAMES[PHASES[i + 1]] : 'آخر مرحلة'}</small></div>
        <button class="btn btn-ghost" id="hbPlayers" aria-label="لوحة التحكم">⚙️ ${S.players.length}</button>
        ${i < PHASES.length - 1 ? `<button class="btn btn-gold" id="hbNext">التالي ←</button>` : `<button class="btn btn-violet" id="hbRestart">↻ جولة</button>`}`;
      $('#hbPrev').onclick = async () => { if (await confirmBox(`ترجع الكل لمرحلة «${PHASE_NAMES[PHASES[i - 1]]}»؟`, 'رجوع')) wsSend({ t: 'phase', phase: 'prev' }); };
      const nx = $('#hbNext'); if (nx) nx.onclick = () => nextPhase(i);
      const rs = $('#hbRestart'); if (rs) rs.onclick = restart;
      $('#hbPlayers').onclick = playersSheet;
    }
  }
  async function nextPhase(i) {
    const to = PHASES[i + 1];
    if (to === 'reveal' && S.doneCount < 1) return toast('لازم شخصية وحدة على الأقل مكتملة');
    if (S.phase === 'create') { const pending = S.players.length - S.doneCount; if (pending > 0 && !(await confirmBox(`${pending} لاعب ما خلّصوا شخصياتهم وبيصيرون متفرجين. نكمل؟`, 'نكمل'))) return; }
    wsSend({ t: 'phase', phase: 'next' });
  }
  async function restart() { if (await confirmBox('تبدأ لعبة جديدة بنفس اللاعبين؟ كل الشخصيات والرسائل بتنمسح.', 'ابدأ من جديد', true)) wsSend({ t: 'restart' }); }

  function playersSheet() {
    const st = S.settings || { names: [] };
    const m = modal(`<div class="sheet"><div class="sheet-head"><h3>لوحة التحكم 👑</h3><button class="icon-btn" data-close>✕</button></div>
      <div class="tabs row" style="margin-bottom:12px"><button class="btn btn-sm btn-gold grow" data-tab="p">👥 اللاعبين</button><button class="btn btn-sm btn-ghost grow" data-tab="n">📋 الأسماء</button><button class="btn btn-sm btn-ghost grow" data-tab="s">⚙️ إعدادات</button></div>
      <div class="row wrap" style="margin-bottom:12px"><button class="btn btn-violet btn-sm grow" id="cpBank">📚 بنك الأسئلة (${(S.bank || []).length})</button>${PHASES.indexOf(S.phase) >= 2 ? `<button class="btn btn-gold btn-sm grow" id="cpVote" ${S.phase === 'vote' ? 'disabled' : ''}>🗳️ ابدأ التصويت الحين</button><button class="btn btn-ghost btn-sm grow" id="cpChat" ${S.phase === 'chat' ? 'disabled' : ''}>💬 روح للمحادثة</button>` : ''}</div>
      <div data-pane="p"><p class="small muted" style="margin:0 0 4px">${S.players.length} من ${S.maxPlayers} · المرحلة: ${PHASE_NAMES[S.phase]}</p><div id="plist"></div></div>
      <div data-pane="n" class="hidden stack"><p class="small muted" style="margin:0">هذي الأسماء تطلع للاعبين عند الدخول، وتطلع كخيارات في التخمين (مين صاحب الشخصية). اسم في كل سطر.</p>
        <textarea class="input" id="namesIn" rows="10" style="min-height:220px">${esc(st.names.join('\n'))}</textarea>
        <button class="btn btn-gold btn-block" id="saveNames">حفظ الأسماء (${st.names.length})</button></div>
      <div data-pane="s" class="hidden stack">
        ${toggleRow('pickName', 'الدخول باختيار الاسم من القائمة', st.pickName)}
        ${toggleRow('lateJoin', 'السماح بالدخول بعد بدء اللعبة (كمتفرج يصوّت ويخمّن)', st.lateJoin)}
        ${toggleRow('showAnswered', 'إظهار عدّاد «مين جاوب» للاعبين', st.showAnswered)}
        ${toggleRow('elimMode', 'وضع الإقصاء: كل واحد يختار شخصية ويخمّن صاحبها، واللي ينعرف صاحبها صح يطلع وينكشف (مو الأكثر أصوات)', st.elimMode)}
        <button class="btn btn-ghost btn-block" id="unbanBtn">🔓 السماح للمطرودين بالرجوع</button>
        <button class="btn btn-ghost btn-block" id="jumpBtn">⏭ انتقل لمرحلة معيّنة</button>
        <button class="btn btn-danger btn-block" id="restartBtn">↻ إعادة اللعبة بنفس اللاعبين</button></div></div>`);
    $$('[data-tab]', m.el).forEach(b => b.onclick = () => { $$('[data-tab]', m.el).forEach(x => x.className = 'btn btn-sm grow ' + (x === b ? 'btn-gold' : 'btn-ghost')); $$('[data-pane]', m.el).forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab)); });
    $('#saveNames', m.el).onclick = () => { const names = $('#namesIn', m.el).value.split('\n').map(x => x.trim()).filter(Boolean); wsSend({ t: 'settings', names }); $('#saveNames', m.el).textContent = `حفظ الأسماء (${names.length}) ✓`; toast('انحفظت الأسماء ✓'); };
    $$('[data-set]', m.el).forEach(i => i.onchange = () => wsSend({ t: 'settings', [i.dataset.set]: i.checked }));
    $('#cpBank', m.el).onclick = () => { m.close(); bankSheet(); };
    const cv = $('#cpVote', m.el); if (cv) cv.onclick = () => { m.close(); wsSend({ t: 'phase', phase: 'vote' }); };
    const cc = $('#cpChat', m.el); if (cc) cc.onclick = () => { m.close(); wsSend({ t: 'phase', phase: 'chat' }); };
    $('#unbanBtn', m.el).onclick = () => wsSend({ t: 'unban' });
    $('#jumpBtn', m.el).onclick = () => {
      const j = modal(`<div class="sheet"><div class="sheet-head"><h3>انتقل إلى</h3><button class="icon-btn" data-close>✕</button></div><div class="stack">${PHASES.map((p, i) => `<button class="btn ${p === S.phase ? 'btn-gold' : 'btn-ghost'} btn-block" data-jump="${p}">${i + 1}. ${PHASE_NAMES[p]}</button>`).join('')}</div></div>`);
      $$('[data-jump]', j.el).forEach(b => b.onclick = () => { j.close(); m.close(); if (b.dataset.jump !== S.phase) wsSend({ t: 'phase', phase: b.dataset.jump }); });
    };
    const draw = () => {
      $('#plist', m.el).innerHTML = S.players.length ? S.players.map(p => `<div class="player-row"><i class="dot ${p.connected ? '' : 'off'}"></i><div class="grow"><b>${esc(p.name)}</b><div class="small muted">${statusLine(p)}</div></div><button class="btn btn-danger btn-sm" data-kick="${p.id}">طرد</button></div>`).join('') : '<p class="muted center">ما فيه أحد للحين</p>';
      $$('[data-kick]', m.el).forEach(b => b.onclick = async () => { const p = S.players.find(x => x.id === b.dataset.kick); if (p && await confirmBox(`تطرد «${p.name}»؟ ما بيقدر يرجع.`, 'طرد', true)) wsSend({ t: 'kick', pid: p.id }); });
    };
    draw(); playersSheet.redraw = () => document.body.contains(m.el) && draw();
    $('#restartBtn', m.el).onclick = () => { m.close(); restart(); };
  }
  function toggleRow(k, label, on) { return `<label class="toggle"><input type="checkbox" data-set="${k}" ${on ? 'checked' : ''}><span class="sw"></span><span class="grow">${esc(label)}</span></label>`; }
  function statusLine(p) {
    const parts = [p.connected ? 'متصل' : 'غير متصل'];
    if (S.phase === 'create' || S.phase === 'lobby') parts.push(p.done ? 'خلّص شخصيته ✓' : 'يصنع شخصيته…');
    else if (!p.participant) parts.push('متفرج');
    if (S.phase === 'chat') parts.push(p.answered ? 'جاوب ✓' : 'ما جاوب');
    if (S.phase === 'vote') parts.push(p.out ? 'طالع 🚪 ما يصوّت' : p.voted ? 'صوّت ✓' : 'ما صوّت');
    if (S.phase === 'guess') parts.push(p.guessed ? 'خمّن ✓' : 'ما خمّن');
    return parts.join(' · ');
  }

  // ---------- العرض الرئيسي ----------
  function render() {
    if (!S) return;
    chrome(true); renderTop();
    const key = S.phase;
    const fresh = key !== screenKey;
    if (fresh) { screenKey = key; app.innerHTML = ''; scrollTo(0, 0); }
    ({ lobby: vLobby, create: vCreate, reveal: vReveal, chat: vChat, vote: vVote, guess: vGuess, results: vResults })[key](fresh);
    if (playersSheet.redraw) playersSheet.redraw();
    if (bankSheet.redraw) bankSheet.redraw();
  }

  // ١) الانتظار
  function vLobby(fresh) {
    if (fresh) {
      const link = joinLink(S.code);
      app.innerHTML = `
        <section class="panel glass share">
          <div class="qr"><img src="/api/qr?text=${encodeURIComponent(link)}" alt="رمز QR للغرفة"></div>
          <div class="stack center">
            <div class="muted small">رمز الغرفة</div><div class="room-code">${esc(S.code)}</div>
            <div class="link-box">${esc(link)}</div>
            <div class="row"><button class="btn btn-violet grow" id="shareBtn">مشاركة الرابط</button><button class="btn btn-ghost" id="copyBtn">نسخ</button></div>
          </div>
        </section>
        <section class="panel glass"><div class="row" style="justify-content:space-between"><h3>المتصلين</h3><span class="pill" id="lobbyCount"></span></div><div class="names" id="names" style="margin-top:8px"></div></section>
        <section class="panel center muted" id="lobbyHint"></section>`;
      $('#copyBtn').onclick = () => { navigator.clipboard?.writeText(link).then(() => toast('انتسخ الرابط ✓'), () => toast(link)); };
      $('#shareBtn').onclick = () => { if (navigator.share) navigator.share({ title: 'أقنعة', text: 'تعال العب معنا «أقنعة» 🎭', url: link }).catch(() => {}); else $('#copyBtn').click(); };
    }
    $('#lobbyCount').textContent = `${S.players.length} / ${S.maxPlayers}`;
    $('#names').innerHTML = S.players.length ? S.players.map(p => `<span class="name-chip ${p.id === S.you.id ? 'me' : ''} ${p.connected ? '' : 'off'}">${p.id === S.you.id ? '⭐' : '🎭'} ${esc(p.name)}</span>`).join('') : '<span class="muted">بانتظار أول لاعب… شارك الرابط أو رمز QR</span>';
    $('#lobbyHint').innerHTML = isHost() ? 'لما يكتمل الحضور اضغط <b class="gold">التالي</b> عشان يبدأون يصنعون شخصياتهم.' : `أهلًا <b class="gold">${esc(S.you.name)}</b> 👋 انتظر المضيف يبدأ اللعبة…`;
  }

  // ٢) صناعة الشخصية
  function vCreate(fresh) {
    if (isHost()) {
      if (fresh) app.innerHTML = `<section class="panel glass stack"><h2>اللاعبين يصنعون شخصياتهم 🎨</h2><div class="progress"><i id="prog"></i></div><p class="muted" id="progTxt"></p></section><section class="panel glass"><div class="status-list" id="slist"></div></section>`;
      const n = S.players.length; $('#prog').style.width = (n ? S.doneCount / n * 100 : 0) + '%';
      $('#progTxt').textContent = `خلّص ${S.doneCount} من ${n}`;
      $('#slist').innerHTML = S.players.map(p => `<div class="status-item ${p.done ? 'ok' : ''}"><i class="dot ${p.connected ? '' : 'off'}"></i>${esc(p.name)}<span class="st">${p.done ? '✅' : '⏳'}</span></div>`).join('') || '<p class="muted">ما فيه لاعبين</p>';
      return;
    }
    if (fresh || !draft) {
      const mc = S.myChar || {};
      draft = { name: mc.name || '', bio: mc.bio || '', tagline: mc.tagline || '', avatar: mc.avatar || 'p:' + Math.floor(Math.random() * PRESETS.length), done: !!mc.done };
      app.innerHTML = `
        <section class="panel center"><h2>اصنع شخصيتك 🎭</h2><p class="muted small" style="margin:0">لا تكتب شي يفضحك! محد بيعرف إنها أنت… إلا لو خمّنوا 😏</p></section>
        <section class="panel glass stack">
          <div class="av-edit" id="avEdit"><div id="avPrev"></div><span class="badge">📷</span></div>
          <div class="src-btns">
            <button class="btn btn-ghost" data-src="gallery"><span>🖼️</span>الاستديو</button>
            <button class="btn btn-ghost" data-src="camera"><span>📸</span>الكاميرا</button>
            <button class="btn btn-ghost" data-src="preset"><span>🎭</span>أفاتار جاهز</button>
          </div>
          <label class="field"><span>الاسم الوهمي</span><input class="input" id="cName" maxlength="30" placeholder="مثلًا: الذيب الأزرق"></label>
          <label class="field"><span>كلمة تعريفية <i class="count" id="cTagC"></i></span><input class="input" id="cTag" maxlength="60" placeholder="جملة تختصر شخصيتك"></label>
          <label class="field"><span>السيرة <i class="count" id="cBioC"></i></span><textarea class="input" id="cBio" maxlength="300" rows="4" placeholder="مين هي شخصيتك؟ وش تحب؟ وش قصتها؟"></textarea></label>
          <div id="doneArea"></div>
        </section>`;
      $('#cName').value = draft.name; $('#cTag').value = draft.tagline; $('#cBio').value = draft.bio;
      const counts = () => { $('#cTagC').textContent = `${$('#cTag').value.length}/60`; $('#cBioC').textContent = `${$('#cBio').value.length}/300`; };
      counts();
      let t;
      const save = (now) => { clearTimeout(t); const f = () => wsSend({ t: 'char', name: draft.name, bio: draft.bio, tagline: draft.tagline, avatar: draft.avatar, done: draft.done }); now ? f() : (t = setTimeout(f, 600)); };
      const bind = (id, k) => $(id).oninput = () => { draft[k] = $(id).value; counts(); if (k === 'name' && !draft.name.trim() && draft.done) { draft.done = false; drawDone(); } save(); };
      bind('#cName', 'name'); bind('#cTag', 'tagline'); bind('#cBio', 'bio');
      const drawAv = () => { $('#avPrev').innerHTML = avatar(draft.avatar, 140); };
      drawAv();
      const fromFile = async (camera) => {
        const f = await pickFile({ camera }); if (!f) return;
        const b = await cropper(f); if (!b) return;
        $('#avPrev').innerHTML = '<div class="spinner" style="margin:50px auto"></div>';
        try { draft.avatar = await upload(b); save(true); } catch (e) { toast(e.message); }
        drawAv();
      };
      $('#avEdit').onclick = () => fromFile(false);
      $$('[data-src]').forEach(b => b.onclick = () => {
        if (b.dataset.src === 'gallery') return fromFile(false);
        if (b.dataset.src === 'camera') return fromFile(true);
        const m = modal(`<div class="sheet"><div class="sheet-head"><h3>اختر أفاتار</h3><button class="icon-btn" data-close>✕</button></div><div class="preset-grid">${PRESETS.map((_, i) => `<button data-p="${i}" class="${draft.avatar === 'p:' + i ? 'sel' : ''}">${avatar('p:' + i, 68)}</button>`).join('')}</div></div>`);
        $$('[data-p]', m.el).forEach(x => x.onclick = () => { draft.avatar = 'p:' + x.dataset.p; drawAv(); save(true); m.close(); });
      });
      const drawDone = () => {
        $('#doneArea').innerHTML = draft.done
          ? `<div class="done-badge">✅ شخصيتك جاهزة! تقدر تعدّل عليها لين ينقلكم المضيف</div>`
          : `<button class="btn btn-gold btn-block" id="doneBtn">جاهز ✓</button>`;
        const db = $('#doneBtn'); if (db) db.onclick = () => { if (!draft.name.trim()) return toast('اكتب اسم شخصيتك'); draft.done = true; save(true); drawDone(); sfx('pop'); };
      };
      drawDone();
    }
  }

  // ٣) الكشف
  function cardHTML(c, { instant = false } = {}) {
    const k = charCache.get(c.id) || c; const open = c.open;
    const mine = c.id === S.myCharId;
    return `<div class="flip ${open ? 'open' : ''} ${instant ? 'instant' : ''} ${mine ? 'mine' : ''} ${!open && isHost() ? 'host-can' : ''}" data-card="${c.id}">
      <div class="inner">
        <div class="face front"><span class="q">🎭</span><span class="n">؟ ؟ ؟</span></div>
        <div class="face back">${open ? backHTML(k, c) : ''}</div>
      </div></div>`;
  }
  function backHTML(k, c) {
    return `${avatar(k.avatar, 74)}<div class="cname">${esc(k.name)}</div><div class="ctag">${esc(k.tagline)}</div>${c.id === S.myCharId ? '<span class="chip gold">شخصيتك</span>' : ''}<div class="mini-reacts" data-mini="${c.id}">${miniReacts(c)}</div>`;
  }
  function miniReacts(c) { return Object.entries(c.reacts || {}).map(([e, n]) => `<span>${e}${n}</span>`).join(' '); }

  function spotHTML(c) {
    const k = charCache.get(c.id) || c;
    return `<section class="glass spot" data-spot="${c.id}"><div class="spot-label">✨ البطاقة المكشوفة</div>${avatar(k.avatar, 120).replace('class="av"', 'class="av" style="margin:10px auto 0;--s:120px"')}
      <div class="cname">${esc(k.name)}</div><div class="ctag">${esc(k.tagline)}</div><div class="cbio">${esc(k.bio)}</div>
      <div class="reacts" style="margin-top:14px" data-spotreacts="${c.id}">${isHost() ? reactsHTML(c.reacts, [], {}) || '<span class="muted small">بانتظار التفاعلات…</span>' : reactsHTML(c.reacts, c.mine, { all: true })}</div></section>`;
  }
  function updateCardReacts(id) {
    const c = S && S.cards && S.cards.find(x => x.id === id); if (!c) return;
    const mini = $(`[data-mini="${id}"]`); if (mini) mini.innerHTML = miniReacts(c);
    const sr = $(`[data-spotreacts="${id}"]`); if (sr) sr.innerHTML = isHost() ? reactsHTML(c.reacts, []) : reactsHTML(c.reacts, c.mine, { all: true });
  }

  function vReveal(fresh) {
    const cards = S.cards || [];
    const openN = cards.filter(c => c.open).length;
    if (fresh) {
      app.innerHTML = `<section class="panel center"><h2>الكشف 🃏</h2><p class="muted small" id="revHint" style="margin:0"></p></section><div id="spotWrap"></div><div class="cards-grid" id="grid"></div><div id="revFoot" class="panel"></div>`;
      $('#grid').innerHTML = cards.map(c => cardHTML(c, { instant: true })).join('');
      cards.forEach(c => c.open && seen.flipped.add(c.id));
      $('#grid').onclick = (e) => {
        const el = e.target.closest('[data-card]'); if (!el) return; const c = S.cards.find(x => x.id === el.dataset.card); if (!c) return;
        if (!c.open) { if (isHost()) wsSend({ t: 'flip', charId: c.id }); else toast('المضيف هو اللي يكشف البطاقات'); return; }
        spotlightId = c.id; drawSpot(true);
      };
      $('#spotWrap').onclick = (e) => { const b = e.target.closest('[data-react]'); if (!b || isHost()) return; b.classList.add('bump'); sfx('react'); wsSend({ t: 'cardReact', charId: $('[data-spot]').dataset.spot, emoji: b.dataset.react }); };
      if (!spotlightId) { const last = cards.filter(c => c.open).pop(); spotlightId = last ? last.id : null; }
    } else {
      // تحديث البطاقات: اقلب الجديد بحركة
      for (const c of cards) {
        const el = $(`[data-card="${c.id}"]`); if (!el) { $('#grid').insertAdjacentHTML('beforeend', cardHTML(c)); continue; }
        if (c.open && !el.classList.contains('open')) {
          $('.face.back', el).innerHTML = backHTML(charCache.get(c.id) || c, c);
          el.classList.remove('instant', 'host-can'); void el.offsetWidth; el.classList.add('open');
          seen.flipped.add(c.id);
        }
      }
      $$('[data-card]').forEach(el => { if (!cards.some(c => c.id === el.dataset.card)) el.remove(); });
    }
    $('#revHint').textContent = isHost() ? `اضغط على أي بطاقة عشان تنكشف عند الكل · مكشوف ${openN} من ${cards.length}` : `مكشوف ${openN} من ${cards.length} · تفاعل مع البطاقة المكشوفة`;
    $('#revFoot').innerHTML = isHost() && openN < cards.length ? `<button class="btn btn-ghost btn-block" id="flipAll">اكشف الكل دفعة وحدة</button>` : '';
    const fa = $('#flipAll'); if (fa) fa.onclick = () => wsSend({ t: 'flipAll' });
    drawSpot(false);
  }
  function drawSpot(force) {
    const wrap = $('#spotWrap'); if (!wrap) return;
    const c = S.cards.find(x => x.id === spotlightId && x.open);
    if (!c) { wrap.innerHTML = ''; return; }
    const cur = $('[data-spot]', wrap);
    if (!force && cur && cur.dataset.spot === c.id) return;
    wrap.innerHTML = spotHTML(c);
  }

  // ٤) المحادثة
  function charOf(id) { return charCache.get(id) || (S.cards || []).find(c => c.id === id) || { name: 'شخصية', avatar: 'p:0' }; }
  function vChat(fresh) {
    const q = S.question;
    const canAnswer = !isHost() && S.myCharId;
    if (fresh) {
      app.innerHTML = `<div class="chat-wrap">
        <section class="glass qbar" id="qbar"></section>
        <div class="msgs" id="msgs"></div>
        <div class="composer" id="composer"></div></div>`;
      renderChatList();
      buildComposer(canAnswer);
      $('#msgs').onclick = onMsgsClick;
    }
    // الشريط المثبت
    const qb = $('#qbar');
    if (!q) qb.innerHTML = `<div class="qtext muted">${isHost() ? 'اكتب أول سؤال تحت 👇' : 'بانتظار سؤال المضيف…'}</div>`;
    else {
      qb.innerHTML = `<div class="small gold">${S.round > 1 ? `الجولة ${S.round} · ` : ''}السؤال ${S.questionCount}</div><div class="qtext">${esc(q.text)}</div>
        <div class="qmeta">${S.answeredCount != null ? `<span>✍️ جاوب ${S.answeredCount} من ${S.answererTotal}</span>` : ''}${q.closed ? '<span class="closed-tag">🔒 مقفل</span>' : q.endsAt ? '<span class="timer" id="timer"></span>' : ''}${S.iAnswered ? '<span class="gold">✓ جاوبت</span>' : ''}</div>
        ${isHost() ? `<div class="small muted" style="margin-top:6px">${S.players.filter(p => p.participant).map(p => `${p.answered ? '✅' : '⏳'} ${esc(p.name)}`).join(' · ')}</div>` : ''}`;
      tickTimer();
    }
    if (isHost()) { const cb = $('#closeQ'); if (cb) cb.disabled = !q || q.closed; drawHostQCtl(); }
    else updateComposerLock();
  }
  let timerI = 0;
  function tickTimer() {
    clearInterval(timerI);
    const step = () => {
      const el = $('#timer'); const q = S && S.question; if (!el || !q || !q.endsAt) return clearInterval(timerI);
      const s = Math.max(0, Math.ceil((q.endsAt - serverNow()) / 1000));
      el.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; el.classList.toggle('low', s <= 10);
    };
    step(); timerI = setInterval(step, 500);
  }

  function itemsFor() {
    const items = [];
    const byQ = new Map(); hist.messages.forEach(m => { if (!byQ.has(m.qid)) byQ.set(m.qid, []); byQ.get(m.qid).push(m); });
    hist.questions.forEach(q => { items.push({ kind: 'q', ...q }); (byQ.get(q.id) || []).forEach(m => items.push({ kind: 'm', ...m })); });
    return items;
  }
  function itemHTML(it) {
    if (it.kind === 'q') return `<div class="qdiv" data-qid="${it.id}">❓ ${esc(it.text)}</div>`;
    const c = charOf(it.charId);
    return `<div class="msg ${it.own ? 'own' : ''}" data-mid="${it.id}">${avatar(c.avatar, 40)}
      <div class="bubble"><div class="who">${esc(c.name)}</div>${it.text ? `<div class="txt">${esc(it.text)}</div>` : ''}${it.img ? `<img class="pic" src="${esc(it.img)}" alt="صورة" loading="lazy" data-full="${esc(it.img)}">` : ''}
      <div class="msg-foot"><span class="rx" style="display:contents">${reactsHTML(it.reacts, it.mine)}</span>${isHost() ? `<button class="del-btn" data-del="${it.id}">🗑 حذف</button>` : `<button class="react-btn add" data-add="${it.id}" aria-label="أضف تفاعل">+😊</button>`}</div></div></div>`;
  }
  function renderChatList() {
    const box = $('#msgs'); if (!box) return;
    const items = itemsFor();
    box.innerHTML = items.length ? items.map(itemHTML).join('') : `<div class="empty">🎭 هنا بتظهر الأجوبة بأسماء الشخصيات</div>`;
    scrollBottom(true);
  }
  function nearBottom() { return innerHeight + scrollY >= document.documentElement.scrollHeight - 220; }
  function scrollBottom(force) { if (force || nearBottom()) requestAnimationFrame(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: force ? 'auto' : 'smooth' })); }
  function appendItem(it, isMsg) {
    const box = $('#msgs'); if (!box) return;
    const stick = nearBottom() || (isMsg && it.own) || !isMsg;
    $('.empty', box)?.remove();
    box.insertAdjacentHTML('beforeend', itemHTML(it));
    if (stick) scrollBottom(true);
  }
  function onMsgsClick(e) {
    const pic = e.target.closest('[data-full]'); if (pic) return lightbox(pic.dataset.full);
    const del = e.target.closest('[data-del]'); if (del) { confirmBox('تحذف هذي الرسالة عند الكل؟', 'حذف', true).then(ok => ok && wsSend({ t: 'delMsg', id: del.dataset.del })); return; }
    if (isHost()) return;
    const add = e.target.closest('[data-add]'); if (add) return emojiPicker(em => { sfx('react'); wsSend({ t: 'msgReact', id: add.dataset.add, emoji: em }); });
    const r = e.target.closest('[data-react]'); if (r) { const mid = r.closest('[data-mid]').dataset.mid; r.classList.add('bump'); sfx('react'); wsSend({ t: 'msgReact', id: mid, emoji: r.dataset.react }); }
  }

  function buildComposer(canAnswer) {
    const box = $('#composer');
    if (isHost()) {
      box.innerHTML = `<div class="glass host-ask"><textarea class="input" id="qIn" rows="2" maxlength="300" placeholder="اكتب السؤال اللي بيجاوبون عليه…" style="min-height:70px"></textarea>
        <div class="row"><select class="input" id="qTimer" aria-label="المؤقت"><option value="0">بدون مؤقت</option><option value="30">30 ثانية</option><option value="60">دقيقة</option><option value="90">دقيقة ونص</option><option value="120">دقيقتين</option><option value="180">3 دقائق</option><option value="300">5 دقائق</option></select>
        <button class="btn btn-gold grow" id="askBtn">اطرح السؤال</button><button class="btn btn-danger" id="closeQ">🔒 اقفل</button></div>
        <div class="row wrap" id="qCtl" style="margin-top:8px"></div></div>`;
      try { $('#qTimer').value = localStorage.getItem('aqnia.timer') || '0'; } catch {}
      $('#qTimer').onchange = () => { try { localStorage.setItem('aqnia.timer', $('#qTimer').value); } catch {} };
      $('#askBtn').onclick = async () => {
        const text = $('#qIn').value.trim(); if (!text) return toast('اكتب السؤال');
        if (S.question && !S.question.closed && !(await confirmBox('السؤال الحالي مفتوح. تقفله وتطرح الجديد؟', 'اطرح'))) return;
        if (wsSend({ t: 'ask', text, timer: $('#qTimer').value })) $('#qIn').value = '';
      };
      $('#closeQ').onclick = () => wsSend({ t: 'closeQ' });
      $('#qCtl').onclick = async (e) => {
        const b = e.target.closest('[data-qc]'); if (!b) return; const a = b.dataset.qc;
        if (a === 'bank') return bankSheet();
        if (a === 'vote') { if (await confirmBox('تنقل الكل للتصويت الحين؟ تقدر ترجعهم للمحادثة بعدين.', 'ابدأ التصويت')) wsSend({ t: 'phase', phase: 'vote' }); return; }
        if (a === 'reopen') return wsSend({ t: 'reopenQ', timer: $('#qTimer').value });
        if (a === 'plus') return wsSend({ t: 'extendQ', secs: 30 });
        if (a === 'minus') return wsSend({ t: 'extendQ', secs: -30 });
        if (a === 'notimer') return wsSend({ t: 'extendQ', clear: true });
        if (a === 'edit') { const m = modal(`<div class="sheet"><h3>تعديل السؤال الحالي</h3><textarea class="input" id="eq" maxlength="300">${esc(S.question.text)}</textarea><button class="btn btn-gold btn-block" style="margin-top:10px" data-ok>حفظ</button></div>`); $('[data-ok]', m.el).onclick = () => { wsSend({ t: 'editQ', text: $('#eq', m.el).value }); m.close(); }; }
      };
      drawHostQCtl();
      return;
    }
    if (canAnswer && (S.cards || []).find(c => c.id === S.myCharId)?.out) { box.innerHTML = `<div class="glass panel center muted" style="margin:0">🚫 شخصيتك انقصت. تقدر تتابع وتتفاعل بالإيموجي</div>`; return; }
    if (!canAnswer) { box.innerHTML = `<div class="glass panel center muted" style="margin:0">👀 أنت متفرج في هذي الجولة</div>`; return; }
    const me = charOf(S.myCharId);
    box.innerHTML = `<div class="small muted" style="padding:0 8px 6px">تكتب باسم <b class="gold">${esc(me.name)}</b></div>
      <div class="glass box" style="flex-direction:column;align-items:stretch">
        <div class="attach-prev hidden" id="attPrev"></div>
        <div class="row" style="align-items:flex-end;gap:6px"><button class="icon-btn" id="attBtn" aria-label="إرفاق صورة">🖼️</button>
        <textarea id="mIn" rows="1" maxlength="500" placeholder="جاوب بلسان شخصيتك…"></textarea>
        <button class="icon-btn send" id="sendBtn" aria-label="إرسال">➤</button></div></div>`;
    const ta = $('#mIn');
    ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); sendMsg(); } };
    $('#sendBtn').onclick = sendMsg;
    $('#attBtn').onclick = async () => {
      const f = await pickFile(); if (!f) return;
      const prev = $('#attPrev'); prev.classList.remove('hidden'); prev.innerHTML = '<div class="spinner" style="margin:6px;width:24px;height:24px"></div><span class="small muted">نضغط ونرفع الصورة…</span>';
      try { const b = await compress(f); const url = await upload(b); pendingImg = { url }; prev.innerHTML = `<img src="${url}" alt=""><span class="small muted grow">${Math.round(b.size / 1024)} ك.ب</span><button class="btn btn-ghost btn-sm" id="rmAtt">إزالة</button>`; $('#rmAtt').onclick = clearAtt; }
      catch (e) { toast(e.message || 'فشل رفع الصورة'); clearAtt(); }
    };
    updateComposerLock();
  }
  function drawHostQCtl() {
    const box = $('#qCtl'); if (!box) return; const q = S.question;
    const bankN = (S.bank || []).length;
    let h = `<button class="btn btn-ghost btn-sm" data-qc="bank">📚 بنك الأسئلة${bankN ? ` (${bankN})` : ''}</button>`;
    if (q && !q.closed) { h += `<button class="btn btn-ghost btn-sm" data-qc="edit">✏️ تعديل</button>`; h += q.endsAt ? `<button class="btn btn-ghost btn-sm" data-qc="plus">+30ث</button><button class="btn btn-ghost btn-sm" data-qc="minus">−30ث</button><button class="btn btn-ghost btn-sm" data-qc="notimer">⏱✕ بدون مؤقت</button>` : `<button class="btn btn-ghost btn-sm" data-qc="plus">⏱ أضف 30ث</button>`; }
    if (q && q.closed) h += `<button class="btn btn-ghost btn-sm" data-qc="reopen">🔓 أعد فتح السؤال</button>`;
    h += `<button class="btn btn-violet btn-sm" data-qc="vote">🗳️ ابدأ جولة التصويت</button>`;
    if (box.innerHTML !== h) box.innerHTML = h;
  }
  function bankSheet() {
    const m = modal(`<div class="sheet"><div class="sheet-head"><h3>📚 بنك الأسئلة</h3><button class="icon-btn" data-close>✕</button></div>
      <p class="small muted" style="margin:0 0 8px">جهّز أسئلتك مقدمًا (سؤال في كل سطر)، واطرح أي واحد بضغطة. إذا طرحت سؤال من مرحلة ثانية ينتقل الكل للمحادثة.</p>
      <textarea class="input" id="bankIn" rows="3" placeholder="وش أغرب شي سويته؟&#10;لو تقدر تعيش في أي زمن، وش تختار؟"></textarea>
      <button class="btn btn-violet btn-block" id="bankAdd" style="margin-top:8px">أضف للبنك</button><div id="bankList" class="stack" style="margin-top:12px"></div></div>`);
    const draw = () => {
      if (!document.body.contains(m.el)) return;
      const b = S.bank || [];
      $('#bankList', m.el).innerHTML = b.length ? b.map((q, i) => `<div class="guess-item row"><div class="grow">${esc(q)}</div>${PHASES.indexOf(S.phase) >= 2 ? `<button class="btn btn-gold btn-sm" data-ask="${i}">اطرح</button>` : ''}<button class="btn btn-danger btn-sm" data-bdel="${i}">✕</button></div>`).join('') : '<p class="muted center small">البنك فاضي</p>';
    };
    draw(); bankSheet.redraw = draw;
    $('#bankAdd', m.el).onclick = () => { const v = $('#bankIn', m.el).value.trim(); if (!v) return; wsSend({ t: 'bankAdd', text: v }); $('#bankIn', m.el).value = ''; };
    $('#bankList', m.el).onclick = (e) => {
      const a = e.target.closest('[data-ask]'), d = e.target.closest('[data-bdel]');
      if (a) { const i = +a.dataset.ask; wsSend({ t: 'ask', text: S.bank[i], bankIndex: i, timer: $('#qTimer') ? $('#qTimer').value : 0 }); m.close(); }
      if (d) wsSend({ t: 'bankDel', i: +d.dataset.bdel });
    };
  }
  function clearAtt() { pendingImg = null; const p = $('#attPrev'); if (p) { p.classList.add('hidden'); p.innerHTML = ''; } }
  function updateComposerLock() {
    const ta = $('#mIn'); if (!ta) return;
    const open = S.question && !S.question.closed;
    ta.disabled = !open; $('#sendBtn').disabled = !open; $('#attBtn').disabled = !open;
    ta.placeholder = open ? 'جاوب بلسان شخصيتك…' : (S.question ? '🔒 السؤال مقفل، انتظر الجاي' : 'انتظر سؤال المضيف…');
  }
  function sendMsg() {
    const ta = $('#mIn'); const text = ta.value.trim();
    if (!text && !pendingImg) return;
    if (wsSend({ t: 'msg', text, img: pendingImg ? pendingImg.url : null })) { ta.value = ''; ta.style.height = 'auto'; clearAtt(); sfx('pop'); }
  }

  // الإقصاء: نزع قناع الشخصية المقصاة لحظيًا عند الكل
  function checkElim(d) {
    const outs = (d.cards || []).filter(c => c.out);
    if (seen.out === null) { seen.out = new Set(outs.map(c => c.id)); return; }
    for (const c of outs) {
      if (seen.out.has(c.id)) continue; seen.out.add(c.id);
      if (d.phase === 'results') continue;
      const k = charOf(c.id);
      const m = modal(`<div class="sheet center"><div class="spot-label">🚪 انقصت في الجولة ${c.out}</div>
        <div class="unmask-card fresh" style="justify-content:center;flex-direction:column;background:none;border:0;box-shadow:none"><div class="av-wrap">${avatar(k.avatar, 120)}<div class="mask-fly" style="font-size:80px">🎭</div></div>
        <div class="gold" style="font-size:20px"><b>${esc(k.name)}</b></div><div class="small muted">صاحبها هو…</div><div class="owner" style="font-size:28px">${esc(c.outOwner)}${c.outOwnerId === S.you.id ? ' <span class="chip gold">أنت</span>' : ''}</div></div>
        <button class="btn btn-gold btn-block" data-close style="margin-top:12px">تمام</button></div>`);
      setTimeout(() => confetti(60), 900);
    }
    for (const id of [...seen.out]) if (!outs.some(c => c.id === id)) seen.out.delete(id);
  }

  // ٥) التصويت
  function vVote(fresh) {
    const cards = S.cards || [];
    if (fresh) app.innerHTML = `<section class="panel center"><h2>${S.elimMode ? 'مين يطلع؟ 🚪' : 'التصويت 🗳️'} <span class="small gold">الجولة ${S.round || 1}</span></h2><p class="muted small" style="margin:0">${S.elimMode ? (isHost() ? 'كل لاعب يختار شخصية ويخمّن صاحبها. اللي ينعرف صاحبها صح يطلع، مو الأكثر أصوات' : (S.iAmOut ? '🚪 طلعت من اللعبة، تقدر تتابع بس ما تصوّت' : 'اختار شخصية وخمّن مين صاحبها. إذا خمّنت صح تطلع وتاخذ نقطتين 🎯')) : (isHost() ? 'اللاعبين يصوّتون لأفضل شخصية' : 'مين أفضل شخصية؟ صوت واحد، وتقدر تغيّره لين يقفل المضيف التصويت')}</p></section>
      <section class="panel glass"><div class="row" style="justify-content:space-between"><span id="vCount"></span></div><div class="progress" style="margin-top:8px"><i id="vProg"></i></div><div id="vWho" class="small muted" style="margin-top:8px"></div></section><div class="pick-list" id="vList"></div>`;
    const n = S.voterTotal ?? S.players.length;
    $('#vCount').textContent = `صوّت ${S.voteCount} من ${n}`; $('#vProg').style.width = (n ? S.voteCount / n * 100 : 0) + '%';
    if (isHost()) {
      $('#vWho').innerHTML = S.players.map(p => `${p.out ? '🚪' : p.voted ? '✅' : '⏳'} ${esc(p.name)}`).join(' · ') + lockCtl('vote', S.voteLocked) + `<label class="toggle" style="margin-top:10px"><input type="checkbox" id="showTally" ${showTally ? 'checked' : ''}><span class="sw"></span><span class="grow">اعرض لي عدد الأصوات لكل شخصية (لك فقط)</span></label>`;
      $('#showTally').onchange = (e) => { showTally = e.target.checked; vVote(false); };
      bindLockCtl('vote');
      if (S.elimMode) { $('#vWho').insertAdjacentHTML('beforeend', '<button class="btn btn-danger btn-block" id="elimTop" style="margin-top:10px">🎯 اكشف اللي انعرفوا صح</button>'); $('#elimTop').onclick = async () => { if (await confirmBox('تكشف وتطلّع كل شخصية خمّن أحد صاحبها صح في هالجولة؟', 'اكشف', true)) wsSend({ t: 'eliminate', top: true }); }; }
      $('#vWho').insertAdjacentHTML('beforeend', '<div class="row" style="margin-top:10px"><button class="btn btn-violet grow" id="newRound">🔁 جولة جديدة</button><button class="btn btn-gold grow" id="endGame">🏁 إنهاء اللعبة</button></div><p class="small muted" style="margin:6px 0 0">الجولة الجديدة ترجعكم للمحادثة بنفس الشخصيات والرسائل، وأصوات هذي الجولة تنحفظ وتنحسب في النتائج.</p>');
      $('#newRound').onclick = async () => { if (await confirmBox(`تنهي تصويت الجولة ${S.round} وتبدأ الجولة ${S.round + 1}؟`, 'جولة جديدة')) wsSend({ t: 'newRound' }); };
      $('#endGame').onclick = async () => { if (await confirmBox('تنهي اللعبة وتنتقلون للتخمين ثم النتائج؟', 'إنهاء اللعبة')) wsSend({ t: 'phase', phase: 'guess' }); };
    } else if (S.iAmOut) $('#vWho').innerHTML = '<span class="closed-tag">🚪 طلعت، ما تقدر تصوّت</span>';
    else if (S.voteLocked) $('#vWho').innerHTML = '<span class="closed-tag">🔒 التصويت مقفل</span>';
    else if (S.elimMode && S.myVote && S.myVoteName) $('#vWho').innerHTML = `🎯 تخمينك: «${esc(charOf(S.myVote).name)}» صاحبها <b class="gold">${esc(S.myVoteName)}</b>`;
    else $('#vWho').innerHTML = '';
    $('#vList').innerHTML = cards.map(c => {
      const k = charOf(c.id); const mine = c.id === S.myCharId; const sel = S.myVote === c.id;
      const outTag = c.out ? `<span class="chip bad">🚪 انقصت (ج${c.out}) · ${esc(c.outOwner)}</span>` : '';
      const hostCtl = isHost() ? (c.out ? `<span class="chip" data-restore="${c.id}" style="cursor:pointer">↩️ رجّعها</span>` : `<span class="chip bad" data-elim="${c.id}" style="cursor:pointer">🚪 اقصِ</span>`) : '';
      return `<div class="pick ${sel ? 'sel' : ''} ${mine || isHost() || c.out || S.iAmOut ? 'dis' : ''}" data-vote="${c.id}" role="button" style="${c.out ? 'opacity:.45' : ''}">${avatar(k.avatar, 56)}<div class="grow"><div class="pname">${esc(k.name)}</div><div class="ptag">${esc(k.tagline)}</div>${outTag}</div><span class="check">${mine ? '<span class="chip gold">شخصيتك</span>' : sel ? '⭐' : ''}${isHost() && (showTally || S.elimMode) && !c.out ? `<span class="chip gold">${(S.tally || {})[c.id] || 0} 🗳️</span>` : ''}${hostCtl}</span></div>`;
    }).join('');
    $('#vList').onclick = (e) => {
      const el = e.target.closest('[data-elim]'), rs = e.target.closest('[data-restore]');
      if (el) { const k = charOf(el.dataset.elim); confirmBox(`تقصي «${k.name}» وتكشف صاحبها للكل؟`, 'اقصِ', true).then(ok => ok && wsSend({ t: 'eliminate', charId: el.dataset.elim })); return; }
      if (rs) { wsSend({ t: 'eliminate', charId: rs.dataset.restore, restore: true }); return; }
      const b = e.target.closest('[data-vote]'); if (!b || isHost()) return;
      if (S.cards.find(c => c.id === b.dataset.vote)?.out) return toast('هذي الشخصية انقصت');
      if (b.dataset.vote === S.myCharId) return toast('ما تقدر تصوّت لشخصيتك 😏');
      if (S.iAmOut) return toast('🚪 طلعت من اللعبة، ما تقدر تصوّت');
      if (S.voteLocked) return toast('التصويت مقفل 🔒');
      if (!S.elimMode) { sfx('pop'); wsSend({ t: 'vote', charId: b.dataset.vote }); return; }
      const cid = b.dataset.vote, k = charOf(cid);
      const people = (S.guessNames || []).filter(x => x !== S.you.name);
      const cur = S.myVote === cid ? S.myVoteName : '';
      const m = modal(`<div class="sheet center">${avatar(k.avatar, 80)}<h3 class="gold" style="margin:8px 0 4px">${esc(k.name)}</h3><p class="small muted" style="margin:0 0 10px">مين تتوقع صاحبها؟ إذا خمّنت صح تطلع 🎯</p>
        <select class="input" id="vName"><option value="">— مين صاحبها؟ —</option>${people.map(x => `<option value="${esc(x)}" ${cur === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
        <div class="row" style="margin-top:12px"><button class="btn btn-ghost grow" data-close>إلغاء</button><button class="btn btn-gold grow" id="vSend">صوّت</button></div></div>`);
      $('#vSend', m.el).onclick = () => { const nm = $('#vName', m.el).value; if (!nm) return toast('اختار اسم'); sfx('pop'); wsSend({ t: 'vote', charId: cid, name: nm }); m.close(); };
    };
  }

  let showTally = false;
  function lockCtl(what, locked) {
    return `<div class="row" style="margin-top:10px"><button class="btn btn-sm ${locked ? 'btn-gold' : 'btn-ghost'} grow" data-lock="${what}" data-locked="${locked ? 1 : 0}">${locked ? '🔓 افتح' : '🔒 اقفل'} ${what === 'vote' ? 'التصويت' : 'التخمين'}</button><button class="btn btn-sm btn-danger" data-reset="${what}">تصفير</button></div>`;
  }
  function bindLockCtl(what) {
    const l = $(`[data-lock="${what}"]`); if (l) l.onclick = () => wsSend({ t: 'lock', what, locked: l.dataset.locked !== '1' });
    const r = $(`[data-reset="${what}"]`); if (r) r.onclick = async () => { if (await confirmBox(what === 'vote' ? 'تصفّر كل الأصوات؟' : 'تصفّر كل التخمينات؟', 'تصفير', true)) wsSend({ t: 'resetVotes', what }); };
  }

  // ٦) التخمين
  let myGuess = {};
  function vGuess(fresh) {
    const cards = (S.cards || []).filter(c => c.id !== S.myCharId && !c.out);
    const people = (S.guessNames || []).filter(n => n !== S.you.name);
    if (fresh) {
      myGuess = { ...(S.myGuesses || {}) };
      app.innerHTML = `<section class="panel center"><h2>التخمين 🕵️</h2><p class="muted small" style="margin:0">${isHost() ? 'اللاعبين يخمّنون صاحب كل شخصية' : 'لكل شخصية، اختار مين تتوقع صاحبها الحقيقي. تخميناتك تنحفظ تلقائيًا'}</p></section>
        <section class="panel glass"><div id="gCount"></div><div class="progress" style="margin-top:8px"><i id="gProg"></i></div><div id="gWho" class="small muted" style="margin-top:8px"></div></section><div class="stack" id="gList"></div>`;
      if (!isHost()) {
        $('#gList').innerHTML = cards.map(c => { const k = charOf(c.id); return `<div class="guess-item ${myGuess[c.id] ? 'has' : ''}" data-gi="${c.id}"><div class="row">${avatar(k.avatar, 52)}<div class="grow"><div class="pname gold"><b>${esc(k.name)}</b></div><div class="small" style="color:var(--violet2)">${esc(k.tagline)}</div></div></div>
          <select class="input" data-guess="${c.id}"><option value="">— مين صاحبها؟ —</option>${people.map(n => `<option value="${esc(n)}" ${myGuess[c.id] === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`; }).join('') || '<p class="muted center">ما فيه شخصيات تخمّنها</p>';
        let t;
        $('#gList').onchange = (e) => {
          const s = e.target.closest('[data-guess]'); if (!s) return;
          if (s.value) myGuess[s.dataset.guess] = s.value; else delete myGuess[s.dataset.guess];
          s.closest('.guess-item').classList.toggle('has', !!s.value);
          clearTimeout(t); t = setTimeout(() => wsSend({ t: 'guess', guesses: myGuess }), 250);
        };
      } else {
        $('#gList').innerHTML = cards.map(c => { const k = charOf(c.id); return `<div class="guess-item"><div class="row" style="margin:0">${avatar(k.avatar, 44)}<b class="gold">${esc(k.name)}</b></div></div>`; }).join('');
      }
    }
    const n = S.players.length;
    const mineN = Object.keys(myGuess).length;
    $('#gCount').textContent = isHost() ? `خمّن ${S.guessCount} من ${n}` : `خمّنت ${mineN} من ${cards.length} · أرسل تخمينه ${S.guessCount} من ${n}`;
    $('#gProg').style.width = (isHost() ? (n ? S.guessCount / n : 0) : (cards.length ? mineN / cards.length : 0)) * 100 + '%';
    if (isHost()) { $('#gWho').innerHTML = S.players.map(p => `${p.guessed ? '✅' : '⏳'} ${esc(p.name)}`).join(' · ') + lockCtl('guess', S.guessLocked); bindLockCtl('guess'); }
    else { $('#gWho').innerHTML = S.guessLocked ? '<span class="closed-tag">🔒 التخمين مقفل</span>' : ''; $$('[data-guess]').forEach(x => x.disabled = !!S.guessLocked); }
  }

  // ٧) النتائج
  function vResults(fresh) {
    const cards = S.cards || []; const un = new Map((S.unmasked || []).map(u => [u.charId, u]));
    if (fresh) {
      app.innerHTML = `<section class="panel center"><h2>نزع الأقنعة 🎭</h2><p class="muted small" id="resHint" style="margin:0"></p></section>
        <div id="hostRes"></div><div id="boardWrap"></div><div id="unList"></div>`;
    }
    $('#resHint').textContent = `انكشف ${un.size} من ${S.totalToUnmask}`;
    const hr = $('#hostRes');
    if (isHost() && !S.showBoard) {
      hr.innerHTML = `<div class="row" style="margin-bottom:14px">${un.size < cards.length ? `<button class="btn btn-gold grow" id="unBtn">🎭 انزع القناع التالي</button>` : ''}<button class="btn btn-violet grow" id="boardBtn">🏆 لوحة الصدارة</button></div>`;
      const ub = $('#unBtn'); if (ub) ub.onclick = () => wsSend({ t: 'unmask' });
      $('#boardBtn').onclick = async () => { if (un.size < cards.length && !(await confirmBox('بنكشف كل الأقنعة الباقية ونعرض لوحة الصدارة؟', 'اعرض'))) return; wsSend({ t: 'board' }); };
    } else hr.innerHTML = '';

    // لوحة الصدارة
    const bw = $('#boardWrap');
    if (S.showBoard && S.board) {
      if (!bw.dataset.done) {
        const medals = ['🥇', '🥈', '🥉'];
        bw.innerHTML = `<section class="panel glass"><h2 class="center">🏆 لوحة الصدارة</h2><ol class="board">${S.board.map((b, i) => `<li style="animation-delay:${i * 80}ms"><span class="rank">${medals[i] || i + 1}</span>${b.charId ? avatar(charOf(b.charId).avatar, 44) : ''}<div class="grow"><b>${esc(b.name)}</b>${b.pid === S.you.id ? ' <span class="chip gold">أنت</span>' : ''}<div class="small muted">${b.charId ? esc(charOf(b.charId).name) + ' · ' : ''}🗳️ ${b.votePts} · 🕵️ ${b.guessPts}${b.stealth ? ' · 🥷 ' + b.stealth : ''}</div>${b.titles.map(t => `<span class="chip gold">🥷 ${esc(t)}</span>`).join('')}</div><span class="pts">${b.total}<small> نقطة</small></span></li>`).join('')}</ol>
          <p class="rules">${S.elimMode ? '🗳️ كل تخمين صحيح وقت التصويت = نقطتين · ' : '🗳️ كل صوت لشخصيتك = نقطة · '}🕵️ كل تخمين صحيح = نقطتين · 🥷 إذا محد عرف شخصيتك = 3 نقاط ولقب «سيد التمويه»</p>
          ${isHost() ? '<button class="btn btn-violet btn-block" id="againBtn">↻ العب جولة ثانية بنفس اللاعبين</button>' : ''}</section>`;
        bw.dataset.done = '1';
        const ab = $('#againBtn'); if (ab) ab.onclick = restart;
        if (!seen.board) { seen.board = true; setTimeout(() => confetti(220), 200); setTimeout(() => confetti(120), 900); }
        else if (fresh) { /* إعادة تحميل: بدون كونفيتي مكرر */ }
      }
    } else { bw.innerHTML = ''; delete bw.dataset.done; }

    // قائمة البطاقات
    const order = [...cards].sort((a, b) => { const ia = S.unmasked.findIndex(u => u.charId === a.id), ib = S.unmasked.findIndex(u => u.charId === b.id); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); });
    const list = $('#unList');
    const firstLoad = fresh;
    let fresher = null;
    list.innerHTML = order.map(c => {
      const k = charOf(c.id); const u = un.get(c.id);
      const isNew = u && !seen.unmasked.has(c.id) && !firstLoad;
      if (u && !seen.unmasked.has(c.id)) { seen.unmasked.add(c.id); if (isNew) fresher = c.id; }
      const myG = S.myGuesses && S.myGuesses[c.id];
      const gChip = !u || isHost() || c.id === S.myCharId ? '' : myG ? (myG === u.ownerName ? '<span class="chip ok">✓ خمّنت صح</span>' : '<span class="chip bad">✗ تخمينك غلط</span>') : '<span class="chip">ما خمّنت</span>';
      return `<section class="glass unmask-card ${u ? (isNew ? 'fresh' : 'done') : 'locked'}" data-un="${c.id}">
        <div class="av-wrap">${avatar(k.avatar, 72)}<div class="mask-fly">🎭</div></div>
        <div class="grow"><div class="gold"><b>${esc(k.name)}</b></div>
        ${u ? `<div class="owner">${esc(u.ownerName)}${u.ownerId === S.you.id ? ' <span class="chip gold">أنت</span>' : ''}</div>
          ${c.out ? `<span class="chip bad">🚪 انقصت في الجولة ${c.out}</span>` : `<span class="chip">🗳️ ${u.votes} صوت</span><span class="chip">🕵️ عرفه ${u.correct} من ${u.guessers}</span>${u.correct === 0 ? '<span class="chip gold">🥷 سيد التمويه</span>' : ''}${gChip}`}`
        : `<div class="muted">؟ ؟ ؟</div>`}</div></section>`;
    }).join('');
    if (fresh) (S.unmasked || []).forEach(u => seen.unmasked.add(u.charId));
    if (fresher) { const el = $(`[data-un="${fresher}"]`); el && el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => confetti(50), 700); }
  }

  // ---------- البداية ----------
  addEventListener('popstate', boot);
  function boot() {
    const m = /^\/([A-Za-z0-9]{5})\/?$/.exec(location.pathname) || (new URLSearchParams(location.search).get('r') || '').match(/^([A-Za-z0-9]{5})$/);
    const code = m ? m[1].toUpperCase() : null;
    const saved = store.get();
    if (saved && (!code || saved.code === code)) {
      session = saved; app.innerHTML = '<div class="spinner"></div>';
      if (location.pathname !== '/' + saved.code) history.replaceState(null, '', '/' + saved.code);
      if (!ws || ws.readyState > 1) connect(); else wsSend({ t: 'resume', code: session.code, token: session.token });
      return;
    }
    if (code) return renderJoin(code);
    renderHome();
  }
  boot();
})();
