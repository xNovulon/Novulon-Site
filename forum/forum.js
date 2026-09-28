/* Novulon forum and account pages. One script for every page; <body data-page="..."> picks the page. */
(function () {
  'use strict';

  const GAMES = { sims: 'The Sims 4', inzoi: 'inZOI' };
  const $ = (sel, root) => (root || document).querySelector(sel);
  const qs = new URLSearchParams(location.search);

  // ---- tiny DOM helpers ----------------------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : String(kid));
    }
    return el;
  }
  const ICONS = {
    pin: '<path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 15v6"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    quote: '<path d="M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4.5 7 7.5 6 7.5-6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    warn: '<path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17.2v.3"/>',
    sims: '<path d="M12 2.8 17 12l-5 9.2L7 12z"/><path d="M7 12h10"/>',
    inzoi: '<path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5-2-6.5L3.5 12 10 10z"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/>',
    out: '<path d="M14 5h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10"/>',
  };
  function icon(name) {
    const t = document.createElement('template');
    t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return t.content.firstChild;
  }

  // ---- API ------------------------------------------------------------------------------------------------
  async function api(method, path, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch('/api/' + path, opt); } catch (e) {
      const err = new Error("Can't connect. Try again."); err.code = 'net'; throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Try again.');
      err.code = data.code; err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
  let mePromise = null;
  function me(fresh) {
    if (!mePromise || fresh) mePromise = api('GET', 'auth/me').then((d) => d.user).catch(() => null);
    return mePromise;
  }

  // ---- formatting -----------------------------------------------------------------------------------------
  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) { const n = Math.round(s / 3600); return n + (n === 1 ? ' hour ago' : ' hours ago'); }
    if (s < 7 * 86400) { const n = Math.round(s / 86400); return n === 1 ? 'yesterday' : n + ' days ago'; }
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function when(ms) {
    return h('time', { datetime: new Date(ms).toISOString(), title: new Date(ms).toLocaleString(), 'data-ago': ms }, ago(ms));
  }
  setInterval(() => document.querySelectorAll('time[data-ago]').forEach((t) => { t.textContent = ago(Number(t.dataset.ago)); }), 60000);
  function joined(ms) { return 'Joined ' + new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); }
  function short(n) { return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  const PAIRS = [['#ff4f9a', '#a855f7'], ['#a855f7', '#6366f1'], ['#f59e0b', '#ff4f9a'], ['#34d399', '#0ea5e9'],
    ['#fb7185', '#f59e0b'], ['#22d3ee', '#a855f7'], ['#e879f9', '#f472b6'], ['#818cf8', '#22d3ee']];
  function avatar(name, size) {
    let hash = 7;
    for (const c of String(name).toLowerCase()) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const pair = PAIRS[hash % PAIRS.length];
    const el = h('span', { class: 'avatar' + (size ? ' ' + size : ''), 'aria-hidden': 'true' }, String(name).charAt(0) || '?');
    el.style.setProperty('--a', pair[0]); el.style.setProperty('--b', pair[1]);
    return el;
  }
  function gchip(game) { return h('span', { class: 'gchip ' + game }, GAMES[game] || game); }
  function flag(kind, label) { return h('span', { class: 'flag ' + kind, title: label, 'aria-label': label }, icon(kind)); }

  // Post text: plain text with line breaks, links, and "> " quote blocks. Built as DOM nodes, never as HTML.
  function linkify(parent, s) {
    const re = /\bhttps?:\/\/[^\s<>"']+/gi;
    let last = 0, m;
    while ((m = re.exec(s))) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      parent.append(s.slice(last, m.index));
      parent.append(h('a', { href: url, rel: 'nofollow ugc noopener noreferrer', target: '_blank' }, url));
      last = m.index + url.length;
      re.lastIndex = last;
    }
    parent.append(s.slice(last));
  }
  function renderText(text) {
    const frag = document.createDocumentFragment();
    const blocks = [];
    let cur = null;
    for (const line of String(text).split('\n')) {
      const quoted = /^\s*>/.test(line);
      if (!quoted && !line.trim()) { cur = null; continue; }
      if (!cur || cur.quote !== quoted) { cur = { quote: quoted, lines: [] }; blocks.push(cur); }
      cur.lines.push(quoted ? line.replace(/^\s*>\s?/, '') : line);
    }
    for (const b of blocks) {
      const el = document.createElement(b.quote ? 'blockquote' : 'p');
      let lines = b.lines;
      if (b.quote) {
        const m = lines[0].match(/^@([A-Za-z0-9_.-]{1,20}) wrote:$/);
        if (m) { el.append(h('cite', {}, m[1] + ' wrote')); lines = lines.slice(1); }
      }
      lines.forEach((ln, i) => { if (i) el.append(document.createElement('br')); linkify(el, ln); });
      frag.append(el);
    }
    return frag;
  }

  function toast(text, bad) {
    let t = $('.toast');
    if (!t) { t = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
    t.textContent = text; t.classList.toggle('bad', !!bad); t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function msg(kind, ...kids) { return h('div', { class: 'msg ' + kind, role: kind === 'bad' ? 'alert' : 'status' }, ...kids); }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = label || 'One moment...'; }
    else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  }
  function nextUrl(fallback) {
    const n = qs.get('next');
    return n && /^\/(?![\/\\])/.test(n) ? n : (fallback || '/forum/');
  }
  function here() { return location.pathname + location.search; }
  function counter(input, max, out) {
    const upd = () => { const n = input.value.length; out.textContent = n.toLocaleString() + ' / ' + max.toLocaleString(); out.classList.toggle('over', n > max); };
    input.addEventListener('input', upd); upd();
  }
  function pwField(name, label, opts) {
    const input = h('input', { class: 'input', type: 'password', name, id: name, required: true, autocomplete: opts.auto, minlength: opts.min || null, maxlength: 200 });
    const toggle = h('button', { type: 'button', 'aria-label': 'Show password' }, 'Show');
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password'; toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    return h('label', { class: 'field', for: name }, h('span', {}, label), h('div', { class: 'pw' }, input, toggle), opts.hint ? h('small', {}, opts.hint) : null);
  }
  function field(name, label, attrs, hint) {
    return h('label', { class: 'field', for: name }, h('span', {}, label), h('input', { class: 'input', name, id: name, ...attrs }), hint ? h('small', {}, hint) : null);
  }
  function devLink(data) {
    return data && data.devLink ? h('div', { class: 'devlink' }, 'Local test link: ', h('a', { href: data.devLink }, data.devLink)) : '';
  }

  // ---- header: who is signed in ---------------------------------------------------------------------------
  async function header() {
    const box = $('#who');
    if (!box) return null;
    const user = await me();
    box.textContent = '';
    if (!user) {
      if (!/^\/account\/(login|register)/.test(location.pathname)) {
        box.append(
          h('a', { class: 'btn ghost small', href: '/account/login?next=' + encodeURIComponent(here()) }, 'Sign in'),
          h('a', { class: 'btn primary small', href: '/account/register?next=' + encodeURIComponent(here()) }, 'Join'));
      }
      return null;
    }
    const menu = h('details', { class: 'chip-user' },
      h('summary', {}, avatar(user.name), h('span', { class: 'nm' }, user.name)),
      h('div', { class: 'menu' },
        h('a', { href: '/forum/new' }, 'New thread'),
        h('a', { href: '/forum/user?name=' + encodeURIComponent(user.name) }, 'Your profile'),
        h('a', { href: '/account/' }, 'Account settings'),
        h('div', { class: 'sep' }),
        h('button', { type: 'button', onclick: signOut }, 'Sign out')));
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.open = false; });
    box.append(menu);
    return user;
  }
  async function signOut() {
    try { await api('POST', 'auth/logout', {}); } catch (e) { /* signed out anyway */ }
    location.href = '/forum/';
  }

  // =========================================================================================================
  // Forum: thread list
  // =========================================================================================================
  async function pageList() {
    const state = { game: GAMES[qs.get('game')] ? qs.get('game') : 'all', sort: qs.get('sort') || 'activity', q: qs.get('q') || '', page: Number(qs.get('page')) || 1 };
    const tabs = $('#tabs'), sortBox = $('#sort'), search = $('#q'), list = $('#list'), pager = $('#pager'), newBtn = $('#new-thread');
    search.value = state.q;

    const user = await me();
    newBtn.href = user ? '/forum/new' + (state.game !== 'all' ? '?game=' + state.game : '') : '/account/login?next=' + encodeURIComponent('/forum/new');

    function url() {
      const p = new URLSearchParams();
      if (state.game !== 'all') p.set('game', state.game);
      if (state.sort !== 'activity') p.set('sort', state.sort);
      if (state.q) p.set('q', state.q);
      if (state.page > 1) p.set('page', state.page);
      const s = p.toString();
      return '/forum/' + (s ? '?' + s : '');
    }
    function drawTabs(counts) {
      tabs.textContent = '';
      for (const [key, label] of [['all', 'All']].concat(Object.entries(GAMES))) {
        tabs.append(h('button', { role: 'tab', type: 'button', 'aria-selected': String(state.game === key),
          onclick: () => { state.game = key; state.page = 1; go(); } }, label, counts ? h('span', { class: 'n' }, short(counts[key] || 0)) : null));
      }
      if (user) newBtn.href = '/forum/new' + (state.game !== 'all' ? '?game=' + state.game : '');
    }
    function drawSort() {
      sortBox.textContent = '';
      for (const [key, label] of [['activity', 'Latest'], ['new', 'Newest'], ['replies', 'Most replies']]) {
        sortBox.append(h('button', { type: 'button', 'aria-pressed': String(state.sort === key), onclick: () => { state.sort = key; state.page = 1; go(); } }, label));
      }
    }
    function skeleton() {
      list.textContent = '';
      list.classList.add('skeleton');
      for (let i = 0; i < 6; i++) {
        list.append(h('div', { class: 'trow' },
          h('div', { class: 't-main' }, h('div', { class: 'bar-s', style: null }), h('div', { class: 'bar-s' })),
          h('div', { class: 'num' }), h('div', { class: 'num views' }), h('div', { class: 'last' })));
      }
      list.querySelectorAll('.t-main .bar-s:first-child').forEach((b) => { b.style.width = (40 + Math.random() * 40) + '%'; });
      list.querySelectorAll('.t-main .bar-s:last-child').forEach((b) => { b.style.width = (50 + Math.random() * 40) + '%'; b.style.opacity = '.6'; });
    }
    function row(t) {
      return h('div', { class: 'trow' + (t.pinned ? ' pinned' : '') },
        h('div', { class: 't-main' },
          h('div', { class: 't-title' }, gchip(t.game), t.pinned ? flag('pin', 'Pinned') : null, t.locked ? flag('lock', 'Locked') : null,
            h('a', { href: '/forum/thread?id=' + t.id }, t.title)),
          t.excerpt ? h('div', { class: 't-ex' }, t.excerpt) : null,
          h('div', { class: 't-meta' }, avatar(t.author, 'sm'), h('b', {}, t.author), h('span', {}, 'started'), when(t.created_at))),
        h('div', { class: 'num' }, h('b', {}, short(t.reply_count)), h('small', {}, t.reply_count === 1 ? 'reply' : 'replies')),
        h('div', { class: 'num views' }, h('b', {}, short(t.view_count)), h('small', {}, 'views')),
        h('div', { class: 'last' }, avatar(t.last_author || t.author, 'sm'),
          h('div', {}, h('b', {}, t.last_author || t.author), h('span', {}, t.reply_count ? 'replied ' : 'posted ', when(t.last_post_at)))));
    }
    function drawPager(page, pages, make) {
      pager.textContent = '';
      if (pages <= 1) return;
      const add = (p, label) => pager.append(p === page ? h('span', { class: 'on', 'aria-current': 'page' }, label || p)
        : h('a', { href: make(p), onclick: (e) => { e.preventDefault(); state.page = p; go(); } }, label || p));
      if (page > 1) add(page - 1, 'Back');
      const show = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
      let prev = 0;
      for (const p of [...show].sort((a, b) => a - b)) { if (p - prev > 1) pager.append(h('span', { class: 'gap' }, '...')); add(p); prev = p; }
      if (page < pages) add(page + 1, 'Next');
    }

    let seq = 0;
    async function load() {
      const mine = ++seq;
      skeleton();
      const p = new URLSearchParams({ sort: state.sort, page: state.page });
      if (state.game !== 'all') p.set('game', state.game);
      if (state.q) p.set('q', state.q);
      try {
        const data = await api('GET', 'threads?' + p);
        if (mine !== seq) return;
        state.page = data.page;
        drawTabs(data.counts);
        list.classList.remove('skeleton');
        list.textContent = '';
        list.append(h('div', { class: 'list-head' }, h('span', {}, 'Thread'), h('span', { class: 'num' }, 'Replies'),
          h('span', { class: 'num' }, 'Views'), h('span', {}, 'Last post')));
        if (!data.threads.length) {
          list.textContent = '';
          list.append(h('div', { class: 'empty' },
            h('h3', {}, state.q ? 'No results' : 'No threads yet'),
            h('a', { class: 'btn primary', href: newBtn.href }, icon('plus'), 'New thread')));
        }
        data.threads.forEach((t) => list.append(row(t)));
        drawPager(data.page, data.pages, (pg) => { const s = { ...state, page: pg }; const u = new URLSearchParams(); if (s.game !== 'all') u.set('game', s.game); if (s.sort !== 'activity') u.set('sort', s.sort); if (s.q) u.set('q', s.q); if (pg > 1) u.set('page', pg); return '/forum/' + (u.toString() ? '?' + u : ''); });
      } catch (e) {
        if (mine !== seq) return;
        list.classList.remove('skeleton');
        list.textContent = '';
        list.append(h('div', { class: 'empty' }, h('h3', {}, e.code === 'setup' ? 'Opening soon' : "Couldn't load threads"),
          e.code === 'setup' ? null : h('button', { class: 'btn', type: 'button', onclick: load }, 'Try again')));
      }
    }
    function go(push = true) {
      drawTabs(null); drawSort();
      if (push) history.pushState(null, '', url());
      load();
      if (push) window.scrollTo({ top: Math.min(window.scrollY, $('.controls').offsetTop - 80), behavior: 'smooth' });
    }
    let typing;
    search.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { state.q = search.value.trim(); state.page = 1; history.replaceState(null, '', url()); load(); }, 350); });
    $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(typing); state.q = search.value.trim(); state.page = 1; go(); });
    window.addEventListener('popstate', () => {
      const p = new URLSearchParams(location.search);
      state.game = GAMES[p.get('game')] ? p.get('game') : 'all'; state.sort = p.get('sort') || 'activity';
      state.q = p.get('q') || ''; state.page = Number(p.get('page')) || 1; search.value = state.q;
      go(false);
    });
    go(false);
  }

  // =========================================================================================================
  // Forum: one thread
  // =========================================================================================================
  async function pageThread() {
    const root = $('#thread');
    const id = Number(qs.get('id'));
    let page = qs.get('page') || '1';
    let data = null;

    function notFound(text) {
      root.textContent = '';
      root.append(h('div', { class: 'empty' }, h('h3', {}, text),
        h('a', { class: 'btn', href: '/forum/' }, icon('back'), 'Back to the forum')));
      document.title = 'Thread not found · Novulon forum';
    }
    if (!id) { notFound('Thread not found'); return; }

    async function load(flashId) {
      try {
        data = await api('GET', `threads/${id}?page=${encodeURIComponent(page)}`);
      } catch (e) { notFound(e.message); return; }
      page = String(data.page);
      const p = new URLSearchParams({ id });
      if (data.page > 1) p.set('page', data.page);
      history.replaceState(null, '', '/forum/thread?' + p + (flashId ? '#r' + flashId : location.hash));
      draw();
      const target = flashId ? $('#r' + flashId) : (location.hash ? document.getElementById(location.hash.slice(1)) : null);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('flash'); }
    }

    function pagerEl() {
      if (data.pages <= 1) return null;
      const box = h('nav', { class: 'pager', 'aria-label': 'Pages' });
      const add = (pg, label) => box.append(pg === data.page ? h('span', { class: 'on', 'aria-current': 'page' }, label || pg)
        : h('a', { href: `/forum/thread?id=${id}&page=${pg}`, onclick: (e) => { e.preventDefault(); page = String(pg); load(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, label || pg));
      if (data.page > 1) add(data.page - 1, 'Back');
      const show = new Set([1, data.pages, data.page - 1, data.page, data.page + 1].filter((x) => x >= 1 && x <= data.pages));
      let prev = 0;
      for (const x of [...show].sort((a, b) => a - b)) { if (x - prev > 1) box.append(h('span', { class: 'gap' }, '...')); add(x); prev = x; }
      if (data.page < data.pages) add(data.page + 1, 'Next');
      return box;
    }

    function side(author, isStarter) {
      return h('div', { class: 'p-side' },
        avatar(author.name, 'lg'),
        h('a', { class: 'name', href: '/forum/user?name=' + encodeURIComponent(author.name) }, author.name),
        author.admin ? h('span', { class: 'role' }, 'Admin') : isStarter ? h('span', { class: 'role op' }, 'Starter') : null,
        h('small', { class: 'extra' }, joined(author.joined), h('br'), plural(author.posts, 'post', 'posts')));
    }

    function quote(name, body) {
      const box = $('#reply-body');
      if (!box) return;
      const lines = body.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').trim();
      const cut = lines.length > 500 ? lines.slice(0, 500).replace(/\s+\S*$/, '') + ' ...' : lines;
      const text = '> @' + name + ' wrote:\n' + cut.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      box.value = (box.value.trim() ? box.value.replace(/\s*$/, '\n\n') : '') + text;
      box.dispatchEvent(new Event('input'));
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function editor(post, current, onSave, withTitle) {
      const body = post.querySelector('.p-body'), foot = post.querySelector('.p-foot');
      const title = withTitle ? h('input', { class: 'input', maxlength: 120, value: data.thread.title, 'aria-label': 'Title' }) : null;
      const area = h('textarea', { class: 'textarea', maxlength: withTitle ? 20000 : 10000, 'aria-label': 'Text' });
      area.value = current;
      const err = h('div');
      const save = h('button', { class: 'btn primary small', type: 'button' }, 'Save');
      const cancel = h('button', { class: 'btn ghost small', type: 'button' }, 'Cancel');
      const box = h('div', { class: 'edit-box' }, title, area, err, h('div', { class: 'row' }, cancel, save));
      body.hidden = true; if (foot) foot.hidden = true;
      body.after(box);
      area.focus();
      cancel.addEventListener('click', () => { box.remove(); body.hidden = false; if (foot) foot.hidden = false; });
      save.addEventListener('click', async () => {
        busy(save, true, 'Saving...'); err.textContent = '';
        try { await onSave(area.value, title && title.value); toast('Saved.'); load(); }
        catch (e) { busy(save, false); err.append(msg('bad', e.message)); }
      });
    }

    function confirmDelete(post, what, run) {
      const foot = post.querySelector('.p-foot');
      const old = [...foot.childNodes];
      foot.textContent = '';
      const yes = h('button', { class: 'btn danger small', type: 'button' }, 'Delete');
      const no = h('button', { class: 'btn ghost small', type: 'button' }, 'Keep');
      foot.append(h('span', { class: 'hint' }, `Delete this ${what}?`), no, yes);
      no.addEventListener('click', () => { foot.textContent = ''; foot.append(...old); });
      yes.addEventListener('click', async () => {
        busy(yes, true, 'Deleting...');
        try { await run(); } catch (e) { toast(e.message, true); foot.textContent = ''; foot.append(...old); }
      });
    }

    function post(opts) {
      const el = h('article', { class: 'post' + (opts.first ? ' first' : ''), id: opts.first ? 'p1' : 'r' + opts.id },
        side(opts.author, opts.starter),
        h('div', { class: 'p-main' },
          h('div', { class: 'p-head' }, when(opts.created_at), opts.edited_at ? h('span', { title: 'Edited ' + new Date(opts.edited_at).toLocaleString() }, '(edited)') : null,
            h('span', { class: 'grow' }), h('a', { class: 'n', href: '#' + (opts.first ? 'p1' : 'r' + opts.id) }, '#' + opts.n)),
          h('div', { class: 'p-body' }, renderText(opts.body)),
          h('div', { class: 'p-foot' })));
      const foot = el.querySelector('.p-foot');
      if (data.can.reply) foot.append(h('button', { class: 'btn ghost small', type: 'button', onclick: () => quote(opts.author.name, opts.body) }, icon('quote'), 'Quote'));
      if (opts.mine || data.can.moderate) {
        foot.append(h('button', { class: 'btn ghost small', type: 'button', onclick: () => editor(el, opts.body, opts.save, opts.first) }, icon('edit'), 'Edit'));
        if (opts.remove) foot.append(h('button', { class: 'btn ghost small', type: 'button', onclick: () => confirmDelete(el, opts.first ? 'thread' : 'reply', opts.remove) }, icon('trash'), 'Delete'));
      }
      if (!foot.childNodes.length) foot.remove();
      return el;
    }

    function composer() {
      const t = data.thread;
      if (data.can.reply) {
        const area = h('textarea', { class: 'textarea', id: 'reply-body', maxlength: 10000, placeholder: 'Write a reply', 'aria-label': 'Your reply' });
        const count = h('span', { class: 'count' });
        const err = h('div');
        const send = h('button', { class: 'btn primary', type: 'submit' }, 'Post reply');
        const form = h('form', { class: 'composer' },
          area, err,
          h('div', { class: 'row' }, h('span', { class: 'grow' }), count, send));
        counter(area, 10000, count);
        const key = 'nv-reply-' + t.id;
        try { area.value = localStorage.getItem(key) || ''; area.dispatchEvent(new Event('input')); } catch (e) { /* no storage */ }
        area.addEventListener('input', () => { try { localStorage.setItem(key, area.value); } catch (e) { /* no storage */ } });
        area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          err.textContent = '';
          busy(send, true, 'Posting...');
          try {
            const r = await api('POST', `threads/${t.id}/replies`, { body: area.value });
            try { localStorage.removeItem(key); } catch (x) { /* no storage */ }
            area.value = '';
            page = String(r.page);
            await load(r.id);
          } catch (x) { err.append(msg('bad', x.message)); }
          busy(send, false);
        });
        return form;
      }
      if (t.locked) return h('div', { class: 'gate' }, h('h3', {}, 'Locked'));
      if (!data.me) {
        return h('div', { class: 'gate' },
          h('h3', {}, 'Sign in to reply'),
          h('div', { class: 'btns' },
            h('a', { class: 'btn', href: '/account/login?next=' + encodeURIComponent(here()) }, 'Sign in'),
            h('a', { class: 'btn primary', href: '/account/register?next=' + encodeURIComponent(here()) }, 'Create account')));
      }
      return h('div', { class: 'gate' }, h('h3', {}, 'This account is blocked from posting'));
    }

    function draw() {
      const t = data.thread;
      document.title = t.title + ' · Novulon forum';
      root.textContent = '';
      const tools = h('div', { class: 'tools' });
      if (data.can.moderate) {
        tools.append(
          h('button', { class: 'btn small', type: 'button', onclick: () => mod({ pinned: !t.pinned }) }, icon('pin'), t.pinned ? 'Unpin' : 'Pin'),
          h('button', { class: 'btn small', type: 'button', onclick: () => mod({ locked: !t.locked }) }, icon('lock'), t.locked ? 'Unlock' : 'Lock'));
      }
      root.append(
        h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '/forum/' }, 'Forum'), h('span', {}, '/'),
          h('a', { href: '/forum/?game=' + t.game }, GAMES[t.game] || t.game)),
        h('header', { class: 'thead' },
          h('h1', {}, t.title),
          h('div', { class: 't-meta' }, gchip(t.game), t.pinned ? flag('pin', 'Pinned') : null, t.locked ? flag('lock', 'Locked') : null,
            h('span', {}, 'Started by ', h('b', {}, t.author.name)), when(t.created_at),
            h('span', {}, plural(t.reply_count, 'reply', 'replies')), h('span', {}, plural(t.view_count, 'view', 'views'))),
          tools.childNodes.length ? tools : null),
        pagerEl() || '');
      const posts = h('div', { class: 'posts' });
      if (data.page === 1) {
        posts.append(post({
          first: true, n: 1, author: t.author, starter: true, created_at: t.created_at, edited_at: t.edited_at, body: t.body, mine: t.mine,
          save: (body, title) => api('PATCH', `threads/${t.id}`, { body, title }),
          remove: data.can.deleteThread ? async () => { await api('DELETE', `threads/${t.id}`); location.href = '/forum/?game=' + t.game; } : null,
        }));
      }
      for (const r of data.replies) {
        posts.append(post({
          id: r.id, n: r.n, author: r.author, starter: r.author.name === t.author.name, created_at: r.created_at, edited_at: r.edited_at, body: r.body, mine: r.mine,
          save: (body) => api('PATCH', `replies/${r.id}`, { body }),
          remove: async () => { await api('DELETE', `replies/${r.id}`); toast('Reply deleted.'); load(); },
        }));
      }
      root.append(posts);
      const bottomPager = pagerEl();
      if (bottomPager) root.append(bottomPager);
      if (data.page === data.pages) root.append(composer());
      else root.append(h('div', { class: 'gate' }, h('h3', {}, `Page ${data.page} of ${data.pages}`),
        h('a', { class: 'btn primary', href: `/forum/thread?id=${t.id}&page=${data.pages}`, onclick: (e) => { e.preventDefault(); page = 'last'; load(); } }, 'Last page')));
    }

    async function mod(change) {
      try { await api('POST', `threads/${id}/moderate`, change); toast('Done.'); load(); }
      catch (e) { toast(e.message, true); }
    }

    await load();
  }

  // =========================================================================================================
  // Forum: new thread
  // =========================================================================================================
  async function pageNew() {
    const user = await me();
    if (!user) { location.replace('/account/login?next=' + encodeURIComponent(here())); return; }
    const form = $('#new-form'), title = $('#title'), body = $('#body'), err = $('#new-error'), send = $('#new-send');
    const want = GAMES[qs.get('game')] ? qs.get('game') : null;
    if (want) form.querySelector(`input[name="game"][value="${want}"]`).checked = true;
    counter(title, 120, $('#title-count'));
    counter(body, 20000, $('#body-count'));
    const key = 'nv-new-thread';
    try {
      const d = JSON.parse(localStorage.getItem(key) || 'null');
      if (d) { title.value = d.title || ''; body.value = d.body || ''; if (!want && d.game) { const r = form.querySelector(`input[name="game"][value="${d.game}"]`); if (r) r.checked = true; } }
      title.dispatchEvent(new Event('input')); body.dispatchEvent(new Event('input'));
    } catch (e) { /* no storage */ }
    form.addEventListener('input', () => {
      const g = form.querySelector('input[name="game"]:checked');
      try { localStorage.setItem(key, JSON.stringify({ title: title.value, body: body.value, game: g && g.value })); } catch (e) { /* no storage */ }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const g = form.querySelector('input[name="game"]:checked');
      if (!g) { err.append(msg('bad', 'Pick a game.')); return; }
      busy(send, true, 'Posting...');
      try {
        const r = await api('POST', 'threads', { game: g.value, title: title.value, body: body.value });
        try { localStorage.removeItem(key); } catch (x) { /* no storage */ }
        location.href = '/forum/thread?id=' + r.id;
      } catch (x) { err.append(msg('bad', x.message)); busy(send, false); }
    });
  }

  // =========================================================================================================
  // Forum: a member's profile
  // =========================================================================================================
  async function pageUser() {
    const root = $('#profile');
    const name = qs.get('name') || '';
    try {
      const d = await api('GET', 'users/' + encodeURIComponent(name));
      const u = d.user;
      document.title = u.name + ' · Novulon forum';
      root.textContent = '';
      root.append(h('div', { class: 'acct' },
        h('div', { class: 'card me' }, avatar(u.name, 'lg'), h('h2', {}, u.name), u.admin ? h('span', { class: 'role' }, 'Admin') : null,
          h('div', { class: 'stats' }, h('div', {}, h('b', {}, short(u.posts)), h('small', {}, 'posts')),
            h('div', {}, h('b', {}, new Date(u.joined).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })), h('small', {}, 'joined')))),
        h('div', { class: 'card' }, h('span', { class: 'label' }, 'Threads started'),
          d.threads.length ? h('div', { class: 'mini-list' }, d.threads.map((t) => h('a', { href: '/forum/thread?id=' + t.id }, gchip(t.game),
            h('span', { class: 't' }, t.title), h('small', {}, plural(t.reply_count, 'reply', 'replies')))))
            : h('p', { class: 'hint' }, 'No threads yet.'))));
    } catch (e) {
      root.textContent = '';
      root.append(h('div', { class: 'empty' }, h('h3', {}, 'Member not found'), h('a', { class: 'btn', href: '/forum/' }, 'Back to the forum')));
    }
  }

  // =========================================================================================================
  // Accounts
  // =========================================================================================================
  function card(...kids) { const c = $('#card'); c.textContent = ''; c.append(...kids.filter((k) => k != null && k !== false)); return c; }
  function resendBox(email, note) {
    const out = h('div');
    const btn = h('button', { class: 'btn wide', type: 'button' }, icon('mail'), 'Resend link');
    btn.addEventListener('click', async () => {
      busy(btn, true, 'Sending...'); out.textContent = '';
      try {
        const d = await api('POST', 'auth/resend', { email });
        out.append(d.mailed === false ? msg('bad', "Couldn't send the email. Try again shortly.") : msg('good', 'Sent.'), devLink(d));
      } catch (e) { out.append(msg('bad', e.message)); }
      busy(btn, false);
    });
    return h('div', { class: 'field' }, note ? h('p', { class: 'sub' }, note) : null, btn, out);
  }

  function checkInbox(email, data) {
    card(h('div', { class: 'big-ico' }, icon('mail')),
      h('div', {}, h('h1', {}, 'Check your inbox'),
        h('p', { class: 'sub' }, 'Confirmation link sent to ', h('b', {}, email), '.')),
      data && data.mailed === false ? msg('bad', "Couldn't send the email. Try again shortly.") : null,
      devLink(data),
      resendBox(email),
      h('p', { class: 'auth-foot' }, h('a', { href: '/account/register' }, 'Use a different email')));
  }

  async function pageLogin() {
    if (await me()) { location.replace(nextUrl()); return; }
    const form = $('#login-form'), err = $('#login-error'), send = $('#login-send');
    $('#to-register').href = '/account/register' + (qs.get('next') ? '?next=' + encodeURIComponent(qs.get('next')) : '');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      busy(send, true, 'Signing in...');
      try {
        await api('POST', 'auth/login', { login: form.login.value, password: form.password.value });
        location.href = nextUrl();
      } catch (x) {
        busy(send, false);
        err.append(msg('bad', x.message));
        if (x.code === 'unverified' && x.data && x.data.email) err.append(resendBox(x.data.email));
      }
    });
  }

  let turnstileId = null;
  async function turnstileSetup(slot) {
    let cfg;
    try { cfg = await api('GET', 'config'); } catch (e) { return; }
    if (!cfg.turnstile) return;
    await new Promise((res) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.onload = res; s.onerror = res;
      document.head.append(s);
    });
    if (window.turnstile) turnstileId = window.turnstile.render(slot, { sitekey: cfg.turnstile, theme: 'dark' });
  }

  async function pageRegister() {
    if (await me()) { location.replace(nextUrl()); return; }
    const form = $('#register-form'), err = $('#register-error'), send = $('#register-send');
    $('#to-login').href = '/account/login' + (qs.get('next') ? '?next=' + encodeURIComponent(qs.get('next')) : '');
    turnstileSetup($('#ts'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (form.password.value !== form.password2.value) { err.append(msg('bad', "Passwords don't match.")); return; }
      busy(send, true, 'Creating...');
      try {
        const d = await api('POST', 'auth/register', {
          username: form.username.value, email: form.email.value, password: form.password.value,
          turnstile: turnstileId != null && window.turnstile ? window.turnstile.getResponse(turnstileId) : undefined,
        });
        try { sessionStorage.setItem('nv-next', nextUrl()); } catch (x) { /* no storage */ }
        checkInbox(d.email, d);
      } catch (x) {
        busy(send, false);
        err.append(msg('bad', x.message));
        if (turnstileId != null && window.turnstile) window.turnstile.reset(turnstileId);
        const bad = { username: form.username, email: form.email, password: form.password }[x.code];
        if (bad) bad.focus();
      }
    });
  }

  async function pageVerify() {
    const token = qs.get('token');
    history.replaceState(null, '', '/account/verify');
    if (!token) {
      card(h('h1', {}, 'Confirm your email'), h('a', { class: 'btn wide', href: '/account/login' }, 'Sign in'));
      return;
    }
    try {
      const d = await api('POST', 'auth/verify', { token });
      let next = '/forum/';
      try { next = sessionStorage.getItem('nv-next') || next; sessionStorage.removeItem('nv-next'); } catch (e) { /* no storage */ }
      card(h('div', { class: 'big-ico ok' }, icon('check')),
        h('div', {}, h('h1', {}, 'Email confirmed'), h('p', { class: 'sub' }, `Welcome, ${d.user.name}.`)),
        h('a', { class: 'btn primary wide', href: next }, 'Go to the forum'));
      header();
      setTimeout(() => { location.href = next; }, 3500);
    } catch (e) {
      const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', autocomplete: 'email', 'aria-label': 'Email' });
      const out = h('div');
      const btn = h('button', { class: 'btn primary wide', type: 'submit' }, 'Send new link');
      const form = h('form', {}, email, btn, out);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault(); out.textContent = ''; busy(btn, true, 'Sending...');
        try { const d = await api('POST', 'auth/resend', { email: email.value }); out.append(msg('good', 'Sent, if the account still needs confirming.'), devLink(d)); }
        catch (x) { out.append(msg('bad', x.message)); }
        busy(btn, false);
      });
      card(h('div', { class: 'big-ico' }, icon('warn')),
        h('div', {}, h('h1', {}, 'Link expired'), h('p', { class: 'sub' }, 'Enter your email for a new one.')),
        form, h('p', { class: 'auth-foot' }, h('a', { href: '/account/login' }, 'Sign in')));
    }
  }

  async function pageForgot() {
    const form = $('#forgot-form'), err = $('#forgot-error'), send = $('#forgot-send');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      busy(send, true, 'Sending...');
      try {
        const d = await api('POST', 'auth/forgot', { email: form.email.value });
        card(h('div', { class: 'big-ico' }, icon('mail')),
          h('div', {}, h('h1', {}, 'Check your inbox'),
            h('p', { class: 'sub' }, 'If ', h('b', {}, form.email.value.trim()), ' has an account, a reset link is on its way.')),
          devLink(d),
          h('a', { class: 'btn wide', href: '/account/login' }, 'Back to sign in'));
      } catch (x) { busy(send, false); err.append(msg('bad', x.message)); }
    });
  }

  async function pageReset() {
    const token = qs.get('token');
    history.replaceState(null, '', '/account/reset');
    if (!token) {
      card(h('h1', {}, 'Reset password'), h('a', { class: 'btn primary wide', href: '/account/forgot' }, 'Get a reset link'));
      return;
    }
    const form = $('#reset-form'), err = $('#reset-error'), send = $('#reset-send');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (form.password.value !== form.password2.value) { err.append(msg('bad', "Passwords don't match.")); return; }
      busy(send, true, 'Saving...');
      try {
        await api('POST', 'auth/reset', { token, password: form.password.value });
        card(h('div', { class: 'big-ico ok' }, icon('check')),
          h('h1', {}, 'Password changed'),
          h('a', { class: 'btn primary wide', href: '/forum/' }, 'Go to the forum'));
        header();
      } catch (x) {
        busy(send, false);
        err.append(msg('bad', x.message));
        if (x.code === 'token') err.append(h('a', { class: 'btn wide', href: '/account/forgot' }, 'Get a new link'));
      }
    });
  }

  async function pageAccount() {
    const user = await me();
    if (!user) { location.replace('/account/login?next=/account/'); return; }
    const root = $('#account');
    const pwForm = h('form', { class: 'card', id: 'pw-form' },
      h('span', { class: 'label' }, 'Change password'),
      pwField('current', 'Current password', { auto: 'current-password' }),
      pwField('password', 'New password', { auto: 'new-password', min: 8 }),
      pwField('password2', 'Confirm password', { auto: 'new-password', min: 8 }),
      h('div', { id: 'pw-error' }),
      h('button', { class: 'btn primary', type: 'submit', id: 'pw-send' }, icon('key'), 'Save'));
    root.textContent = '';
    root.append(h('div', { class: 'acct' },
      h('div', { class: 'card me' }, avatar(user.name, 'lg'), h('h2', {}, user.name), user.admin ? h('span', { class: 'role' }, 'Admin') : null,
        h('p', { class: 'hint' }, user.email),
        h('div', { class: 'stats' }, h('div', {}, h('b', {}, short(user.posts)), h('small', {}, 'posts')),
          h('div', {}, h('b', {}, new Date(user.joined).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })), h('small', {}, 'joined'))),
        h('a', { class: 'btn wide', href: '/forum/user?name=' + encodeURIComponent(user.name) }, 'Your profile'),
        h('button', { class: 'btn ghost wide', type: 'button', onclick: signOut }, icon('out'), 'Sign out')),
      pwForm));
    const err = $('#pw-error'), send = $('#pw-send');
    pwForm.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (pwForm.password.value !== pwForm.password2.value) { err.append(msg('bad', "Passwords don't match.")); return; }
      busy(send, true, 'Saving...');
      try {
        await api('POST', 'auth/password', { current: pwForm.current.value, password: pwForm.password.value });
        pwForm.reset(); err.append(msg('good', 'Password changed.'));
      } catch (x) { err.append(msg('bad', x.message)); }
      busy(send, false);
    });
  }

  // ---- start ----------------------------------------------------------------------------------------------
  // show/hide buttons next to password fields written in the page itself
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-toggle]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.toggle);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  const PAGES = { list: pageList, thread: pageThread, new: pageNew, user: pageUser, login: pageLogin, register: pageRegister,
    verify: pageVerify, forgot: pageForgot, reset: pageReset, account: pageAccount };
  header();
  const run = PAGES[document.body.dataset.page];
  if (run) run().catch((e) => { console.error(e); toast('Something went wrong. Reload the page.', true); });
  window.NVForum = { pwField, field };
})();
