(() => {
  'use strict';

  /* ---------- Константы ---------- */
  const KEY = 'onadream:v1';
  const THEMES = {
    night: { name: 'Ночное небо' },
    jar: { name: 'Банка мечты' },
    sun: { name: 'Рассвет' },
  };
  const RING_C = 2 * Math.PI * 110;
  /* солнце: центр на высоте SUN_EMPTY при 0% (за горизонтом) и SUN_FULL при 100% (над ним) */
  const SUN_EMPTY = 200;
  const SUN_FULL = 90;
  const SUN_BASE = 112;
  const JAR_EMPTY = 310;
  const JAR_FULL = 76;
  const MAX_ENTRIES = 5000;
  const MAX_SHOWN = 50;
  const MS_TEXT = {
    25: 'Четверть пути — отличное начало!',
    50: 'Половина пути пройдена!',
    75: 'Осталась четверть — почти у цели!',
    100: 'Цель достигнута — мечта сбылась!',
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- Хелперы ---------- */
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const fmt = (n) => nf.format(n);

  /** "1 000,5", "+500", "−200" -> { value: 1000.5, sign: '+' | '-' | null } или null */
  function parseAmount(raw) {
    let s = String(raw)
      .replace(/[−–—]/g, '-')
      .replace(/\s/g, '')
      .replace(/,/g, '.');
    let sign = null;
    if (s[0] === '-' || s[0] === '+') {
      sign = s[0];
      s = s.slice(1);
    }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const value = round2(parseFloat(s));
    if (!(value > 0) || value > 1e12) return null;
    return { value, sign };
  }

  /* ---------- Состояние ---------- */
  const DEFAULT_NAME = 'Копилка';
  const MAX_JARS = 12;
  const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00'));

  function normJar(raw, fallbackId) {
    const j = { id: fallbackId, name: DEFAULT_NAME, goal: 0, currency: 'Br', deadline: '', entries: [] };
    if (!raw || typeof raw !== 'object') return j;
    if (typeof raw.id === 'string' && raw.id) j.id = raw.id.slice(0, 40);
    if (typeof raw.name === 'string' && raw.name.trim()) j.name = raw.name.trim().slice(0, 24);
    const goal = Number(raw.goal);
    if (Number.isFinite(goal) && goal > 0) j.goal = goal;
    if (typeof raw.currency === 'string') j.currency = raw.currency.slice(0, 8);
    if (validDate(raw.deadline)) j.deadline = raw.deadline;
    if (Array.isArray(raw.entries)) {
      j.entries = raw.entries
        .filter((e) => e && Number.isFinite(e.amount) && e.amount !== 0 && Number.isFinite(e.ts))
        .slice(0, MAX_ENTRIES)
        .map((e) => ({ id: String(e.id || uid()), amount: round2(e.amount), ts: e.ts }));
    }
    return j;
  }

  /* хранилище: { theme, activeId, jars: [...] }; старый формат (одна копилка) превращается в первую копилку */
  function normalize(raw) {
    const st = { theme: 'night', activeId: '', jars: [] };
    if (raw && typeof raw === 'object') {
      if (typeof raw.theme === 'string' && Object.prototype.hasOwnProperty.call(THEMES, raw.theme)) st.theme = raw.theme;
      if (Array.isArray(raw.jars)) {
        const seen = new Set();
        raw.jars.slice(0, MAX_JARS).forEach((r) => {
          const j = normJar(r, uid());
          if (seen.has(j.id)) j.id = uid();
          seen.add(j.id);
          st.jars.push(j);
        });
      } else {
        st.jars.push(normJar(raw, 'main'));
      }
      if (typeof raw.activeId === 'string') st.activeId = raw.activeId;
    }
    if (!st.jars.length) st.jars.push(normJar(null, 'main'));
    if (!st.jars.some((j) => j.id === st.activeId)) st.activeId = st.jars[0].id;
    return st;
  }

  let hadLocal = false;
  function load() {
    try {
      const rawText = localStorage.getItem(KEY);
      if (rawText === null) return normalize(null);
      hadLocal = true;
      return normalize(JSON.parse(rawText));
    } catch (e) {
      return normalize(null); /* повреждённые данные — начинаем с чистого листа */
    }
  }

  const hasData = (x) => (x.jars || [x]).some((j) => j.goal > 0 || j.entries.length > 0);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  let store = load();
  /* state — рабочая копия активной копилки (+ тема); store.jars хранит все копилки */
  let state = {};
  function activate(id) {
    const j = store.jars.find((x) => x.id === id) || store.jars[0];
    store.activeId = j.id;
    state = { id: j.id, name: j.name, goal: j.goal, currency: j.currency, deadline: j.deadline, entries: j.entries, theme: store.theme };
  }
  function syncStore() {
    const j = store.jars.find((x) => x.id === state.id);
    if (j) {
      j.name = state.name;
      j.goal = state.goal;
      j.currency = state.currency;
      j.deadline = state.deadline;
      j.entries = state.entries;
    }
    store.theme = state.theme;
    store.activeId = state.id;
  }
  const anyData = () => {
    syncStore();
    return hasData(store);
  };
  activate(store.activeId);

  /* Вторая копия в IndexedDB: iOS иногда очищает localStorage, а IndexedDB переживает это чаще */
  const idb = {
    open() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('no idb'));
        const rq = indexedDB.open('kopilka', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
    },
    async get() {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const rq = db.transaction('kv').objectStore('kv').get('state');
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
    },
    async put(value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, 'state');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  function save() {
    syncStore();
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch (e) {
      /* хранилище недоступно (приватный режим и т.п.) */
    }
    idb.put(clone(store)).catch(() => {});
  }

  /* просим браузер не стирать данные сайта */
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { /* не страшно */ }

  const total = () => round2(state.entries.reduce((s, e) => s + e.amount, 0));

  /* ---------- Элементы ---------- */
  const htmlEl = document.documentElement;
  const appEl = $('#app');
  const stage = $('#stage');
  const visual = $('#visual');
  const fxLayer = $('#fx');
  const ringArc = $('#ringArc');
  const ringSvg = $('#ringSvg');
  const jarSvg = $('#jarSvg');
  const sunSvg = $('#sunSvg');
  const sunMove = $('#sunMove');
  const liquid = $('#liquid');
  const lblSaved = $('#lblSaved');
  const lblLeft = $('#lblLeft');
  const ringGoal = $('#ringGoal');
  const doneNote = $('#doneNote');
  const goalHint = $('#goalHint');
  const amountEl = $('#amount');
  const msgEl = $('#msg');
  const listEl = $('#list');
  const emptyEl = $('#empty');
  const moreEl = $('#more');
  const menu = $('#menu');
  const backdrop = $('#backdrop');
  const menuBtn = $('#menuBtn');
  const goalInput = $('#goalInput');
  const curInput = $('#curInput');
  const themeOpts = $$('[data-theme-pick]');
  const resetBtn = $('#resetBtn');
  const toastEl = $('#toast');
  const firstHint = $('#firstHint');
  const tabsEl = $('#jarTabs');
  const jarList = $('#jarList');
  const nameInput = $('#nameInput');
  const deadlineInput = $('#deadlineInput');
  const deadlineClear = $('#deadlineClear');
  const jarDel = $('#jarDel');
  const planEl = $('#plan');

  const binds = {};
  $$('[data-bind]').forEach((el) => {
    (binds[el.dataset.bind] = binds[el.dataset.bind] || []).push(el);
  });
  const setBind = (name, text) => (binds[name] || []).forEach((el) => { el.textContent = text; });

  /* ---------- Числа с анимацией ---------- */
  let shown = { saved: 0, left: 0, pct: 0 };
  let rafId = 0;

  /* размер шрифта подписей в банке подгоняется под длину числа */
  function fitJarLabels(savedText, leftText) {
    const extra = state.currency ? state.currency.length + 1 : 0;
    [[lblSaved, savedText], [lblLeft, leftText]].forEach(([g, t]) => {
      const size = Math.max(11, Math.min(22, 140 / ((t.length + extra) * 0.62)));
      g.querySelector('.jl-num').setAttribute('font-size', size.toFixed(1));
    });
  }

  function writeNumbers(v) {
    const hasGoal = state.goal > 0;
    const savedText = fmt(v.saved);
    const leftText = hasGoal ? fmt(v.left) : '—';
    setBind('saved', savedText);
    setBind('left', leftText);
    setBind('pct', String(Math.floor(v.pct + 1e-9)));
    stage.classList.toggle('long', savedText.length > 10);
    fitJarLabels(savedText, leftText);
  }

  let finishTimer = 0;

  function animateNumbers(target, instant) {
    cancelAnimationFrame(rafId);
    clearTimeout(finishTimer);
    if (instant || reduceMotion) {
      shown = target;
      writeNumbers(target);
      return;
    }
    const from = { ...shown };
    let t0 = null;
    const dur = 900;
    const hasFrac = [from.saved, target.saved, from.left, target.left].some((v) => v % 1 !== 0);
    const lerp = (a, b, k) => a + (b - a) * k;
    const step = (now) => {
      if (t0 === null) t0 = now;
      const k = Math.max(0, Math.min(1, (now - t0) / dur));
      if (k >= 1) {
        shown = target;
        writeNumbers(target);
        return;
      }
      const e = 1 - Math.pow(1 - k, 3);
      const rnd = hasFrac ? round2 : Math.round;
      shown = {
        saved: rnd(lerp(from.saved, target.saved, e)),
        left: rnd(lerp(from.left, target.left, e)),
        pct: lerp(from.pct, target.pct, e),
      };
      writeNumbers(shown);
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    /* страховка: если кадры не идут (фоновая вкладка и т.п.), итоговые числа всё равно появятся */
    finishTimer = setTimeout(() => {
      cancelAnimationFrame(rafId);
      shown = target;
      writeNumbers(target);
    }, dur + 300);
  }

  /* ---------- Визуал ---------- */
  function applyVisual(frac) {
    ringArc.style.strokeDashoffset = (RING_C * (1 - frac)).toFixed(2);
    ringArc.classList.toggle('empty', frac <= 0);
    liquid.style.transform = `translateY(${(JAR_EMPTY - (JAR_EMPTY - JAR_FULL) * frac).toFixed(1)}px)`;
    sunMove.style.transform = `translateY(${(SUN_EMPTY - (SUN_EMPTY - SUN_FULL) * frac - SUN_BASE).toFixed(1)}px)`;
    layoutJarLabels(frac);
  }

  /* «Накоплено» — в заполненной части банки, «осталось» — в пустой.
     Если в какой-то части мало места, подпись переезжает в соседнюю. */
  function layoutJarLabels(frac) {
    const TOP = 100, BOTTOM = 292, H = 34, PAD = 4, GAP = 8;
    const ys = Math.min(BOTTOM, Math.max(TOP, JAR_EMPTY - (JAR_EMPTY - JAR_FULL) * frac));
    const filled = BOTTOM - ys;
    const empty = ys - TOP;
    let leftTop, savedTop, leftOnLiquid, savedOnLiquid;

    if (empty >= H + 2 * PAD) {
      leftOnLiquid = false;
      leftTop = TOP + (empty - H) / 2;
      if (filled >= H + 2 * PAD) {
        savedOnLiquid = true;
        savedTop = ys + (filled - H) / 2;
      } else {
        savedOnLiquid = false;
        savedTop = ys - GAP - H;
        leftTop = TOP + (savedTop - GAP - TOP - H) / 2;
      }
    } else {
      leftOnLiquid = true;
      savedOnLiquid = true;
      leftTop = ys + 14;
      const from = leftTop + H + GAP;
      savedTop = from + (BOTTOM - from - H) / 2;
    }

    lblLeft.style.transform = `translateY(${leftTop.toFixed(1)}px)`;
    lblSaved.style.transform = `translateY(${savedTop.toFixed(1)}px)`;
    lblLeft.classList.toggle('on-liquid', leftOnLiquid);
    lblLeft.classList.toggle('on-glass', !leftOnLiquid);
    lblSaved.classList.toggle('on-liquid', savedOnLiquid);
    lblSaved.classList.toggle('on-glass', !savedOnLiquid);
  }

  function render(opts = {}) {
    const saved = total();
    const goal = state.goal;
    const left = goal > 0 ? Math.max(0, round2(goal - saved)) : 0;
    const frac = goal > 0 ? Math.min(1, Math.max(0, saved / goal)) : 0;

    setBind('goal', goal > 0 ? fmt(goal) : '—');
    setBind('cur', state.currency);
    const goalLen = (goal > 0 ? fmt(goal).length : 1) + (state.currency ? state.currency.length + 1 : 0);
    ringGoal.classList.toggle('long', goalLen > 10);
    const pctInt = Math.floor(frac * 100 + 1e-9);
    const curTxt = state.currency ? ' ' + state.currency : '';
    ringSvg.setAttribute('aria-label', `Накоплено ${pctInt} процентов цели: ${fmt(saved)}${curTxt} из ${goal > 0 ? fmt(goal) : '—'}`);
    sunSvg.setAttribute('aria-label', `Накоплено ${pctInt} процентов цели: ${fmt(saved)}${curTxt} из ${goal > 0 ? fmt(goal) : '—'}`);
    jarSvg.setAttribute('aria-label', `Банка: накоплено ${fmt(saved)}${curTxt}, осталось ${goal > 0 ? fmt(left) : '—'}${goal > 0 ? curTxt : ''}`);
    animateNumbers({ saved, left, pct: frac * 100 }, opts.instant);

    if (opts.deferVisual && !reduceMotion) {
      requestAnimationFrame(() => requestAnimationFrame(() => applyVisual(frac)));
    } else {
      applyVisual(frac);
    }

    const done = goal > 0 && saved >= goal;
    stage.classList.toggle('done', done);
    doneNote.hidden = !done;
    goalHint.hidden = goal > 0;
    renderPlan();
  }

  /* ---------- Срок цели ---------- */
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  function daysWord(n) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'день';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня';
    return 'дней';
  }
  const roundUp = (x) => fmt(x >= 10 ? Math.ceil(x) : Math.ceil(x * 100) / 100);

  function renderPlan() {
    const goal = state.goal;
    if (!state.deadline || !(goal > 0)) {
      planEl.hidden = true;
      return;
    }
    const left = Math.max(0, round2(goal - total()));
    const [y, m, d] = state.deadline.split('-').map(Number);
    const dl = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((dl - today) / 86400000);
    const dateTxt = dl.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: dl.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    const cur = state.currency ? ' ' + state.currency : '';
    let title;
    let sub = '';
    let kind = '';
    if (left <= 0) {
      title = `Цель достигнута к сроку: ${dateTxt}`;
      kind = 'ok';
    } else if (days < 0) {
      title = `Срок (${dateTxt}) прошёл`;
      sub = `Не хватает ${fmt(left)}${cur}`;
      kind = 'late';
    } else if (days === 0) {
      title = 'Срок — сегодня';
      sub = `Осталось собрать ${fmt(left)}${cur}`;
    } else {
      title = `До ${dateTxt} · ${days} ${daysWord(days)}`;
      const parts = [`≈ ${roundUp(left / days)}${cur} в день`];
      if (days >= 7) parts.push(`${roundUp((left / days) * 7)}${cur} в неделю`);
      if (days >= 60) parts.push(`${roundUp((left / days) * 30.4)}${cur} в месяц`);
      sub = 'Откладывайте ' + parts.join(' · ');
    }
    $('#planTitle').textContent = title;
    $('#planSub').textContent = sub;
    $('#planSub').hidden = !sub;
    planEl.className = 'plan' + (kind ? ' ' + kind : '');
    planEl.hidden = false;
  }

  /* ---------- Несколько копилок ---------- */
  function renderTabs() {
    syncStore();
    tabsEl.textContent = '';
    tabsEl.hidden = store.jars.length < 2;
    store.jars.forEach((j) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'jar-tab';
      b.dataset.jar = j.id;
      b.textContent = j.name;
      if (j.id === state.id) b.setAttribute('aria-current', 'true');
      tabsEl.append(b);
    });
    const act = tabsEl.querySelector('[aria-current]');
    if (act) tabsEl.scrollLeft = act.offsetLeft - (tabsEl.clientWidth - act.offsetWidth) / 2;
  }

  function renderJarList() {
    syncStore();
    jarList.textContent = '';
    jarDel.hidden = store.jars.length < 2;
    store.jars.forEach((j) => {
      const saved = round2(j.entries.reduce((sum, e) => sum + e.amount, 0));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.jar = j.id;
      b.setAttribute('aria-pressed', String(j.id === state.id));
      const nm = document.createElement('span');
      nm.className = 'chip-name';
      nm.textContent = j.name;
      const info = document.createElement('span');
      info.className = 'chip-pct';
      info.textContent = j.goal > 0 ? Math.min(100, Math.floor((saved / j.goal) * 100 + 1e-9)) + '%' : '';
      b.append(nm, info);
      jarList.append(b);
    });
  }

  function renderAll(opts) {
    syncMenuInputs();
    renderTabs();
    renderList();
    render(opts);
  }

  function switchJar(id) {
    if (id === state.id) return false;
    syncStore();
    activate(id);
    save();
    amountEl.value = '';
    showMsg('');
    renderAll();
    return true;
  }

  /* ---------- История ---------- */
  function whenText(ts) {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return `сегодня, ${time}`;
    if (diff === 1) return `вчера, ${time}`;
    const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    return d.getFullYear() !== now.getFullYear() ? `${date} ${d.getFullYear()}` : date;
  }

  let freshId = null;

  function renderList() {
    const items = state.entries.slice(0, MAX_SHOWN);
    listEl.textContent = '';
    emptyEl.hidden = items.length > 0;
    moreEl.hidden = state.entries.length <= MAX_SHOWN;
    items.forEach((e) => {
      const li = document.createElement('li');
      li.className = 'item' + (e.id === freshId ? ' fresh' : '');
      li.dataset.id = e.id;

      const amt = document.createElement('span');
      amt.className = 'amt ' + (e.amount > 0 ? 'plus' : 'minus');
      amt.textContent = `${e.amount > 0 ? '+' : '−'}${fmt(Math.abs(e.amount))} ${state.currency}`.trim();

      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = whenText(e.ts);

      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.dataset.del = e.id;
      del.setAttribute('aria-label', 'Удалить запись');
      del.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

      li.append(amt, when, del);
      listEl.append(li);
    });
    freshId = null;
  }

  /* ---------- Сообщения ---------- */
  let msgTimer = 0;
  function showMsg(text, kind) {
    clearTimeout(msgTimer);
    msgEl.textContent = text;
    msgEl.classList.toggle('error', kind === 'error');
    if (text) msgTimer = setTimeout(() => showMsg(''), 4500);
  }

  function shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  function fail(text, el) {
    showMsg(text, 'error');
    if (el) shake(el);
  }

  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }

  /* ---------- Эффекты ---------- */
  function spawn(el, ms) {
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function playFx(delta) {
    if (reduceMotion) return;
    visual.classList.remove('bump');
    void visual.offsetWidth;
    visual.classList.add('bump');

    const label = document.createElement('span');
    label.className = 'float-label ' + (delta > 0 ? 'up' : 'down');
    label.textContent = `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))} ${state.currency}`.trim();
    spawn(label, 1600);

    if (delta <= 0) return;
    if (state.theme === 'jar') {
      const n = delta < 500 ? 1 : delta < 2000 ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const coin = document.createElement('span');
        coin.className = 'coin';
        coin.style.animationDelay = i * 0.18 + 's';
        coin.style.marginLeft = -13 + (i - (n - 1) / 2) * 22 + 'px';
        spawn(coin, 1400 + i * 180);
      }
    } else {
      for (let i = 0; i < 10; i++) {
        const sp = document.createElement('span');
        sp.className = 'spark';
        const a = (Math.PI * 2 * i) / 10 + Math.random() * 0.4;
        const r = 90 + Math.random() * 50;
        sp.style.setProperty('--dx', Math.cos(a) * r + 'px');
        sp.style.setProperty('--dy', Math.sin(a) * r + 'px');
        spawn(sp, 1000);
      }
    }
  }

  function confetti() {
    if (reduceMotion) return;
    const c = $('#confetti');
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.display = 'block';
    const cs = getComputedStyle(htmlEl);
    const palette = [cs.getPropertyValue('--a1').trim(), cs.getPropertyValue('--a2').trim(), '#ffffff', cs.getPropertyValue('--plus').trim()];
    const parts = Array.from({ length: 140 }, (_, i) => ({
      x: w / 2 + (Math.random() - 0.5) * 80,
      y: h * 0.45,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 14 - 4,
      g: 0.35 + Math.random() * 0.2,
      s: 5 + Math.random() * 6,
      r: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 0.4,
      c: palette[i % palette.length],
    }));
    const t0 = performance.now();
    const frame = (now) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      let alive = 0;
      for (const p of parts) {
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.99;
        p.r += p.vr;
        if (p.y < h + 20) alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      }
      if (alive && now - t0 < 4500) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, w, h);
        c.style.display = 'none';
      }
    };
    requestAnimationFrame(frame);
  }

  /* ---------- Операции ---------- */
  function checkMilestones(before, after) {
    if (!(state.goal > 0)) return;
    const p0 = (before / state.goal) * 100;
    const p1 = (after / state.goal) * 100;
    const hit = [100, 75, 50, 25].find((l) => p0 < l && p1 >= l - 1e-9);
    if (!hit) return;
    toast(MS_TEXT[hit]);
    if (hit === 100) confetti();
  }

  function addEntry(delta) {
    const before = total();
    const after = round2(before + delta);
    if (after < 0) {
      fail(`Нельзя достать больше, чем накоплено: сейчас ${fmt(before)} ${state.currency}`.trim(), amountEl);
      return false;
    }
    const entry = { id: uid(), amount: round2(delta), ts: Date.now() };
    state.entries.unshift(entry);
    freshId = entry.id;
    save();
    renderList();
    render();
    playFx(delta);
    checkMilestones(before, after);
    return true;
  }

  function removeEntry(id) {
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) return;
    if (round2(total() - entry.amount) < 0) {
      fail('Эту запись нельзя удалить: накопления стали бы отрицательными.');
      return;
    }
    const li = $(`.item[data-id="${CSS.escape(id)}"]`, listEl);
    const finish = () => {
      state.entries = state.entries.filter((e) => e.id !== id);
      save();
      renderList();
      render();
    };
    if (li && !reduceMotion) {
      li.classList.add('out');
      setTimeout(finish, 260);
    } else {
      finish();
    }
  }

  function submit(sign) {
    const p = parseAmount(amountEl.value);
    if (!p) {
      fail('Введите сумму, например 500', amountEl);
      return;
    }
    if (addEntry(sign * p.value)) {
      amountEl.value = '';
      showMsg('');
    }
  }

  /* ---------- Меню ---------- */
  function syncMenuInputs() {
    if (document.activeElement !== goalInput) goalInput.value = state.goal > 0 ? fmt(state.goal) : '';
    if (document.activeElement !== curInput) curInput.value = state.currency;
    if (document.activeElement !== nameInput) nameInput.value = state.name;
    deadlineInput.value = state.deadline;
    deadlineInput.min = ymd(new Date());
    deadlineClear.hidden = !state.deadline;
    themeOpts.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themePick === state.theme)));
    renderJarList();
  }

  function openMenu(auto) {
    syncMenuInputs();
    updateRestoreHint();
    if (!restoreHint.hidden) setTool('backup');
    firstHint.hidden = !(auto || state.goal === 0);
    menu.removeAttribute('inert');
    appEl.setAttribute('inert', '');
    menu.classList.add('open');
    backdrop.classList.add('open');
    document.body.classList.add('lock');
    menuBtn.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      if (state.goal === 0 && !auto) goalInput.focus({ preventScroll: true });
      else menu.focus({ preventScroll: true });
    }, 120);
  }

  function closeMenu() {
    menu.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.classList.remove('lock');
    menu.setAttribute('inert', '');
    appEl.removeAttribute('inert');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.focus({ preventScroll: true });
    disarmReset();
    disarmJarDel();
    hideBackupBox();
    setTool(null);
  }

  /* ---------- Тема ---------- */
  /* тема, цвет адресной строки, иконка и манифест приложения — см. скрипт в <head> */
  function setIdentity(name) {
    if (typeof window.__setIdentity === 'function') window.__setIdentity(name);
    else htmlEl.setAttribute('data-theme', name);
  }

  function applyTheme(name) {
    state.theme = name;
    setIdentity(name);
    syncMenuInputs();
    save();
  }

  function pickTheme(next) {
    if (next === state.theme || !THEMES[next]) return;
    if (document.startViewTransition && !reduceMotion) {
      let applied = false;
      const run = () => {
        if (applied) return;
        applied = true;
        applyTheme(next);
      };
      document.startViewTransition(run);
      /* если браузер не запустил переход (например, вкладка в фоне), тема всё равно сменится */
      setTimeout(run, 700);
    } else {
      applyTheme(next);
    }
  }

  /* ---------- Сброс ---------- */
  let resetArmed = false;
  let resetTimer = 0;
  function disarmReset() {
    resetArmed = false;
    clearTimeout(resetTimer);
    resetBtn.textContent = 'Обнулить накопления';
    resetBtn.classList.remove('armed');
  }

  let jarDelArmed = false;
  let jarDelTimer = 0;
  function disarmJarDel() {
    jarDelArmed = false;
    clearTimeout(jarDelTimer);
    jarDel.textContent = 'Удалить копилку';
    jarDel.classList.remove('armed');
  }

  /* ---------- События ---------- */
  menuBtn.addEventListener('click', () => openMenu(false));
  $('#menuClose').addEventListener('click', closeMenu);
  backdrop.addEventListener('click', closeMenu);
  $('#goalSet').addEventListener('click', () => openMenu(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) closeMenu();
  });

  themeOpts.forEach((b) => b.addEventListener('click', () => pickTheme(b.dataset.themePick)));

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-jar]');
    if (b) switchJar(b.dataset.jar);
  });
  jarList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-jar]');
    if (!b) return;
    if (b.dataset.jar === state.id) return;
    switchJar(b.dataset.jar);
    closeMenu();
  });

  $('#jarAdd').addEventListener('click', () => {
    if (store.jars.length >= MAX_JARS) {
      toast(`Максимум ${MAX_JARS} копилок`);
      return;
    }
    syncStore();
    let n = store.jars.length + 1;
    while (store.jars.some((j) => j.name === `${DEFAULT_NAME} ${n}`)) n++;
    const j = normJar({ name: `${DEFAULT_NAME} ${n}`, currency: state.currency }, uid());
    store.jars.push(j);
    activate(j.id);
    save();
    amountEl.value = '';
    showMsg('');
    renderAll();
    firstHint.hidden = false;
    goalInput.focus({ preventScroll: true });
  });

  jarDel.addEventListener('click', () => {
    if (store.jars.length < 2) return;
    if (!jarDelArmed) {
      jarDelArmed = true;
      jarDel.textContent = `Точно удалить «${state.name}»? Ещё раз`;
      jarDel.classList.add('armed');
      jarDelTimer = setTimeout(disarmJarDel, 4000);
      return;
    }
    disarmJarDel();
    syncStore();
    const idx = store.jars.findIndex((j) => j.id === state.id);
    store.jars.splice(idx, 1);
    activate(store.jars[Math.max(0, idx - 1)].id);
    save();
    closeMenu();
    renderAll();
    toast('Копилка удалена');
  });

  nameInput.addEventListener('input', () => {
    state.name = nameInput.value.slice(0, 24);
    save();
    renderTabs();
    renderJarList();
  });
  nameInput.addEventListener('blur', () => {
    state.name = nameInput.value.trim() || DEFAULT_NAME;
    nameInput.value = state.name;
    save();
    renderTabs();
    renderJarList();
  });

  deadlineInput.addEventListener('change', () => {
    state.deadline = validDate(deadlineInput.value) ? deadlineInput.value : '';
    save();
    deadlineClear.hidden = !state.deadline;
    renderPlan();
  });
  deadlineClear.addEventListener('click', () => {
    state.deadline = '';
    deadlineInput.value = '';
    save();
    deadlineClear.hidden = true;
    renderPlan();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderPlan();
  });

  goalInput.addEventListener('input', () => {
    const raw = goalInput.value.trim();
    if (raw === '') {
      goalInput.classList.remove('invalid');
      state.goal = 0;
    } else {
      const p = parseAmount(raw);
      if (!p || p.sign === '-') {
        goalInput.classList.add('invalid');
        return;
      }
      goalInput.classList.remove('invalid');
      state.goal = p.value;
    }
    firstHint.hidden = state.goal > 0 ? true : firstHint.hidden;
    save();
    render();
  });
  goalInput.addEventListener('blur', () => {
    goalInput.classList.remove('invalid');
    goalInput.value = state.goal > 0 ? fmt(state.goal) : '';
  });

  curInput.addEventListener('input', () => {
    state.currency = curInput.value.trim().slice(0, 8);
    save();
    setBind('cur', state.currency);
    writeNumbers(shown);
    renderList();
  });

  resetBtn.addEventListener('click', () => {
    if (!resetArmed) {
      resetArmed = true;
      resetBtn.textContent = 'Точно обнулить? Нажмите ещё раз';
      resetBtn.classList.add('armed');
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    state.entries = [];
    save();
    closeMenu();
    renderList();
    render();
    toast('Накопления обнулены');
  });

  $('#plusBtn').addEventListener('click', () => submit(1));
  $('#minusBtn').addEventListener('click', () => submit(-1));
  amountEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const p = parseAmount(amountEl.value);
    submit(p && p.sign === '-' ? -1 : 1);
  });
  amountEl.addEventListener('input', () => {
    const clean = amountEl.value.replace(/[^\d+\-−–.,  ]/g, '');
    if (clean !== amountEl.value) amountEl.value = clean;
  });

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del]');
    if (btn) removeEntry(btn.dataset.del);
  });

  /* ---------- Копия данных (код для переноса) ---------- */
  const backupBox = $('#backupBox');
  const restoreBtn = $('#restoreBtn');
  const restoreHint = $('#restoreHint');
  const standalone = (window.navigator.standalone === true) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  function encodeBackup() {
    syncStore();
    const bytes = new TextEncoder().encode(JSON.stringify(store));
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return 'KOP1:' + btoa(bin);
  }
  function decodeBackup(text) {
    const m = String(text).replace(/\s+/g, '').match(/KOP1:([A-Za-z0-9+/=]+)/);
    if (!m) return null;
    try {
      const bin = atob(m[1]);
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      const st = normalize(JSON.parse(new TextDecoder().decode(bytes)));
      return hasData(st) ? st : null;
    } catch (e) {
      return null;
    }
  }

  let restoreArmed = false;
  function disarmRestore() {
    restoreArmed = false;
    restoreBtn.textContent = 'Восстановить';
    restoreBtn.classList.remove('armed');
  }
  function hideBackupBox() {
    backupBox.hidden = true;
    restoreBtn.hidden = true;
    backupBox.value = '';
    disarmRestore();
  }

  function applyRestored(st) {
    store = st;
    activate(store.activeId);
    save();
    setIdentity(state.theme);
    renderAll({ instant: true });
  }

  $('#copyBtn').addEventListener('click', async () => {
    const code = encodeBackup();
    try {
      await navigator.clipboard.writeText(code);
      hideBackupBox();
      toast('Код скопирован');
    } catch (e) {
      backupBox.hidden = false;
      restoreBtn.hidden = true;
      backupBox.value = code;
      backupBox.focus();
      backupBox.select();
      toast('Скопируйте код вручную');
    }
  });

  $('#pasteBtn').addEventListener('click', async () => {
    disarmRestore();
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { /* iOS спросит разрешение или откажет */ }
    backupBox.hidden = false;
    restoreBtn.hidden = false;
    backupBox.value = text;
    if (!text) backupBox.focus();
  });

  restoreBtn.addEventListener('click', () => {
    const st = decodeBackup(backupBox.value);
    if (!st) {
      toast('Код не распознан');
      return;
    }
    if (anyData() && !restoreArmed) {
      restoreArmed = true;
      restoreBtn.textContent = 'Заменить данные? Нажмите ещё раз';
      restoreBtn.classList.add('armed');
      return;
    }
    hideBackupBox();
    applyRestored(st);
    closeMenu();
    toast('Данные восстановлены');
  });

  /* подсказка в установленном приложении, пока данных нет */
  function updateRestoreHint() {
    restoreHint.hidden = !(standalone && !anyData());
  }

  /* ---------- Калькулятор ---------- */
  const calcPanel = $('#calcPanel');
  const calcExpr = $('#calcExpr');
  const calcRes = $('#calcRes');
  let cExpr = '';      /* то, что набрано */
  let cDone = false;   /* после «=» новая цифра начинает с нуля */
  const OPS = '+−×÷';

  function calcEval(str) {
    const toks = str.match(/\d+(?:\.\d*)?|\.\d+|[+−×÷]/g) || [];
    if (!toks.length) return null;
    const nums = [];
    const ops = [];
    const prec = { '+': 1, '−': 1, '×': 2, '÷': 2 };
    const apply = () => {
      const b = nums.pop();
      const a = nums.pop();
      const o = ops.pop();
      if (a === undefined || b === undefined) throw new Error('syntax');
      if (o === '+') nums.push(a + b);
      else if (o === '−') nums.push(a - b);
      else if (o === '×') nums.push(a * b);
      else {
        if (b === 0) throw new Error('div0');
        nums.push(a / b);
      }
    };
    let expectNum = true;
    let neg = false;
    for (const t of toks) {
      if (OPS.includes(t)) {
        if (expectNum) {
          if (t === '−') { neg = !neg; continue; }
          throw new Error('syntax');
        }
        while (ops.length && prec[ops[ops.length - 1]] >= prec[t]) apply();
        ops.push(t);
        expectNum = true;
      } else {
        nums.push(neg ? -parseFloat(t) : parseFloat(t));
        neg = false;
        expectNum = false;
      }
    }
    if (expectNum) throw new Error('syntax');
    while (ops.length) apply();
    const r = nums[0];
    if (!Number.isFinite(r)) throw new Error('range');
    return Math.round(r * 1e8) / 1e8;
  }
  const calcShow = (n) => String(n).replace('.', ',').replace('-', '−');
  const calcPretty = (str) => str.replace(/\./g, ',');

  function calcRender(error) {
    calcExpr.textContent = calcPretty(cExpr);
    if (error) { calcRes.textContent = error; return; }
    let live = null;
    try { live = calcEval(cExpr); } catch (e) { /* выражение ещё не закончено */ }
    if (live === null) {
      /* показываем последнее набранное число */
      const last = (cExpr.match(/[\d.]+$/) || ['0'])[0];
      calcRes.textContent = calcPretty(last);
    } else {
      calcRes.textContent = calcShow(live);
    }
  }

  function calcKey(k) {
    if (k === 'C') { cExpr = ''; cDone = false; return calcRender(); }
    if (k === '⌫') {
      cExpr = cDone ? '' : cExpr.slice(0, -1);
      cDone = false;
      return calcRender();
    }
    if (k === '=') {
      if (!cExpr) return;
      try {
        const r = calcEval(cExpr);
        if (r === null) return;
        cExpr = String(r).replace('-', '−');
        cDone = true;
        calcRender();
        calcExpr.textContent = '';
      } catch (e) {
        calcRender(e.message === 'div0' ? 'На ноль делить нельзя' : 'Проверьте выражение');
      }
      return;
    }
    const isOp = OPS.includes(k);
    if (cDone && !isOp) cExpr = '';
    cDone = false;
    if (isOp) {
      if (!cExpr) { if (k === '−') cExpr = '−'; return calcRender(); }
      const last = cExpr.slice(-1);
      if (OPS.includes(last)) {
        /* заменить знак; после «×» или «÷» допускаем минус у числа */
        if (k === '−' && '×÷'.includes(last)) cExpr += k;
        else cExpr = cExpr.slice(0, -1) + k;
      } else cExpr += k;
    } else if (k === ',') {
      const seg = cExpr.split(/[+−×÷]/).pop();
      if (seg.includes('.')) return;
      cExpr += seg === '' ? '0.' : '.';
    } else {
      const seg = cExpr.split(/[+−×÷]/).pop();
      if (seg.replace('.', '').length >= 12) return;
      cExpr += k;
    }
    calcRender();
  }

  calcPanel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (b) calcKey(b.dataset.k);
  });
  $('#calcUse').addEventListener('click', () => {
    let r = null;
    try { r = calcEval(cExpr); } catch (e) { /* нечего переносить */ }
    if (r === null || r === 0) { toast('Сначала посчитайте сумму'); return; }
    const v = round2(Math.abs(r));
    if (!(v > 0)) { toast('Сумма слишком маленькая'); return; }
    amountEl.value = (r < 0 ? '−' : '') + String(v).replace('.', ',');
    closeMenu();
    toast('Сумма в поле — нажмите «Добавить» или «Убавить»');
  });
  calcRender();

  /* ---------- Добавить на главный экран ---------- */
  const installBtn = $('#installBtn');
  const installHelp = $('#installHelp');
  let installEvt = null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  installBtn.hidden = standalone;
  installHelp.textContent = isIOS
    ? 'В Safari: «Поделиться» (квадрат со стрелкой внизу экрана) → «На экран “Домой”». Иконка будет в цвете выбранной сейчас темы.'
    : 'В меню браузера (три точки) выберите «Установить приложение» или «Добавить на главный экран».';

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvt = e;
  });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    installBtn.hidden = true;
    toast('Копилка добавлена на главный экран');
  });

  /* ---------- Инструменты в меню: открыт один за раз ---------- */
  const toolBtns = $$('[data-tool]');
  const toolPanels = $$('[data-tool-panel]');
  let openToolName = null;
  function setTool(name) {
    openToolName = name;
    toolBtns.forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.tool === name)));
    toolPanels.forEach((p) => { p.hidden = p.dataset.toolPanel !== name; });
    if (name) {
      const p = toolPanels.find((x) => x.dataset.toolPanel === name);
      setTimeout(() => p && p.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
    }
  }
  toolBtns.forEach((b) => b.addEventListener('click', async () => {
    const name = b.dataset.tool;
    if (name === 'install' && installEvt) {
      const evt = installEvt;
      installEvt = null;
      try {
        evt.prompt();
        await evt.userChoice;
      } catch (e) { /* закрыли окно */ }
      return;
    }
    setTool(openToolName === name ? null : name);
  }));

  /* ---------- Закрыть меню свайпом вправо ---------- */
  (() => {
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let t0 = 0;
    let tracking = false;
    let drag = false;
    menu.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || e.target.closest('[data-noswipe]')) {
        tracking = false;
        return;
      }
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      dx = 0;
      drag = false;
      tracking = true;
      t0 = Date.now();
    }, { passive: true });
    menu.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const ddx = e.touches[0].clientX - sx;
      const ddy = e.touches[0].clientY - sy;
      if (!drag) {
        if (Math.abs(ddy) > 10 && Math.abs(ddy) > Math.abs(ddx)) {
          tracking = false;
          return;
        }
        if (!(ddx > 12 && ddx > Math.abs(ddy) * 1.2)) return;
        drag = true;
        menu.style.transition = 'none';
        backdrop.style.transition = 'none';
      }
      dx = Math.max(0, ddx);
      menu.style.transform = `translateX(${dx}px)`;
      backdrop.style.opacity = String(Math.max(0, 1 - dx / menu.offsetWidth));
      e.preventDefault();
    }, { passive: false });
    const end = () => {
      const wasDrag = tracking && drag;
      tracking = false;
      drag = false;
      if (!wasDrag) return;
      const fast = dx / Math.max(1, Date.now() - t0) > 0.5 && dx > 40;
      menu.style.transition = '';
      backdrop.style.transition = '';
      void menu.offsetWidth;
      if (dx > menu.offsetWidth * 0.3 || fast) closeMenu();
      menu.style.transform = '';
      backdrop.style.opacity = '';
    };
    menu.addEventListener('touchend', end);
    menu.addEventListener('touchcancel', end);
  })();

  /* синхронизация между вкладками */
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const keep = state.id;
    store = load();
    activate(store.jars.some((j) => j.id === keep) ? keep : store.activeId);
    setIdentity(state.theme);
    renderAll({ instant: true });
  });

  /* ---------- Старт ---------- */
  setIdentity(state.theme);
  syncMenuInputs();
  renderTabs();
  renderList();
  render({ deferVisual: true });

  if (!anyData()) {
    setTimeout(() => { if (!anyData()) openMenu(true); }, 900);
  }

  /* localStorage пуст (например, iOS его очистил), а копия в IndexedDB осталась — возвращаем данные */
  if (!hadLocal) {
    idb.get().then((v) => {
      if (!v || anyData()) return;
      const st = normalize(v);
      if (hasData(st)) applyRestored(st);
    }).catch(() => {});
  } else if (anyData()) {
    idb.put(clone(store)).catch(() => {});
  }

  /* работа без интернета и установка на главный экран (нужен https или localhost) */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        /* ищем обновление при каждом возвращении в приложение */
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) reg.update().catch(() => {});
        });
        reg.update().catch(() => {});
      }).catch(() => {});
      /* вышла новая версия — перезагружаем страницу один раз (если не набирается сумма) */
      if (navigator.serviceWorker.controller) {
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloaded || amountEl.value) return;
          reloaded = true;
          location.reload();
        });
      }
    });
  }
})();
