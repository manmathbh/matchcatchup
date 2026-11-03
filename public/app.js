// Missed It? — front end. No framework, no build step.
// All model and feed text is rendered with textContent (never innerHTML).

const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};

const HEADINGS = {
  en: { things: '3 things you missed', win: 'Win chance', turning: 'Turning point', next: 'Watch next', chat: 'Send this to your group', poll: 'Quick poll', copyLine: 'Copy line', copy: 'Copy recap', sharePoll: 'Share poll in the room' },
  hinglish: { things: 'Aapne ye miss kiya', win: 'Jeet ka chance', turning: 'Turning point', next: 'Ab dekhna', chat: 'Group mein bhejo', poll: 'Quick poll', copyLine: 'Line copy karo', copy: 'Recap copy karo', sharePoll: 'Poll room mein daalo' },
  mr: { things: 'तुम्ही चुकवलेल्या गोष्टी', win: 'जिंकण्याची शक्यता', turning: 'टर्निंग पॉइंट', next: 'पुढे काय पाहायचं', chat: 'ग्रुपवर पाठवा', poll: 'झटपट पोल', copyLine: 'ओळ कॉपी करा', copy: 'रिकॅप कॉपी करा', sharePoll: 'पोल रूममध्ये शेअर करा' },
};

const state = {
  snapshot: null,
  source: 'sim',
  sinceTouched: false,
  voterId: store.get('mi.voter', null) || (crypto.randomUUID?.() ?? String(Math.random()).slice(2)),
  myVotes: {},
};
store.set('mi.voter', state.voterId);
try { state.myVotes = JSON.parse(store.get('mi.votes', '{}')) || {}; } catch { /* ignore */ }

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- Theme ---------- */
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get('mi.theme', null));
$('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  store.set('mi.theme', next);
});

/* ---------- Scoreboard ---------- */
function renderScore(s) {
  state.snapshot = s;
  $('batTeam').textContent = s.battingTeam;
  $('bowlTeam').textContent = `vs ${s.bowlingTeam}`;
  $('score').textContent = `${s.score}/${s.wickets}`;
  $('overs').textContent = `(${s.overs})`;
  $('target').textContent = s.target;
  $('equation').textContent = s.status === 'done'
    ? `${s.result}. New match starting soon…`
    : `${s.battingShort} need ${s.runsNeeded} off ${s.ballsLeft} balls · RRR ${s.rrr}`;
  $('liveDot').classList.toggle('off', s.status === 'done');
  $('liveDot').textContent = s.status === 'done' ? 'FINISHED' : 'LIVE';

  $('liveWp').hidden = false;
  $('wpBatLabel').textContent = `${s.battingShort} ${s.wp}%`;
  $('wpBowlLabel').textContent = `${100 - s.wp}% ${s.bowlingShort}`;
  $('wpFill').style.width = `${s.wp}%`;

  const bats = [s.striker && `${s.striker.name}* ${s.striker.runs}(${s.striker.balls})`, s.nonStriker && `${s.nonStriker.name} ${s.nonStriker.runs}(${s.nonStriker.balls})`].filter(Boolean);
  $('crease').textContent = [bats.join(' · '), s.bowler && `Bowler: ${s.bowler.name} ${s.bowler.figures}`].filter(Boolean).join('  |  ');
  $('lastBalls').replaceChildren(...(s.lastOver?.balls ?? []).map((b) => h('span', { class: `ball b${b}`, title: b === '•' ? 'dot ball' : b }, b)));

  updateSlider();
}

function updateSlider() {
  const s = state.snapshot;
  if (!s) return;
  const slider = $('sinceSlider');
  const max = Math.max(0, s.completedOvers - 1);
  slider.max = max;
  if (!state.sinceTouched) slider.value = Math.max(0, s.completedOvers - 4);
  if (Number(slider.value) > max) slider.value = max;
  renderSinceLabel();
}

function renderSinceLabel() {
  const s = state.snapshot;
  const v = Number($('sinceSlider').value);
  $('sinceValue').textContent = v;
  const then = v === 0 ? '0/0' : s?.overHistory?.[v - 1]?.scoreAfter;
  $('sinceScore').textContent = then ? `(${s.battingShort} were ${then})` : '';
}

$('sinceSlider').addEventListener('input', () => { state.sinceTouched = true; renderSinceLabel(); });
$('quickChips').addEventListener('click', (e) => {
  const ago = e.target.closest('[data-ago]')?.dataset.ago;
  if (!ago || !state.snapshot) return;
  state.sinceTouched = true;
  $('sinceSlider').value = Math.max(0, state.snapshot.completedOvers - Number(ago));
  renderSinceLabel();
});

/* ---------- Live connection ---------- */
function connect() {
  const es = new EventSource('/api/live');
  es.addEventListener('snapshot', (e) => renderScore(JSON.parse(e.data)));
  es.addEventListener('over', (e) => renderScore(JSON.parse(e.data).snapshot));
  es.addEventListener('reset', (e) => {
    state.sinceTouched = false;
    renderScore(JSON.parse(e.data));
    toast('New simulated match started');
  });
  es.addEventListener('room', (e) => addRoomItem(JSON.parse(e.data)));
  es.addEventListener('poll', (e) => updatePoll(JSON.parse(e.data)));
  es.onerror = () => { $('liveDot').classList.add('off'); $('liveDot').textContent = 'RECONNECTING'; };
  es.onopen = () => { $('liveDot').classList.remove('off'); };
}

/* ---------- Form ---------- */
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  state.source = tab.dataset.source;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t === tab);
    t.setAttribute('aria-selected', String(t === tab));
  });
  $('simFields').hidden = state.source !== 'sim';
  $('pasteFields').hidden = state.source !== 'paste';
}));

$('commentary').addEventListener('input', (e) => { $('charCount').textContent = e.target.value.length; });

for (const name of ['fanType', 'language']) {
  const saved = store.get(`mi.${name}`, null);
  const input = saved && document.querySelector(`input[name="${name}"][value="${saved}"]`);
  if (input) input.checked = true;
  document.querySelectorAll(`input[name="${name}"]`).forEach((i) => i.addEventListener('change', () => store.set(`mi.${name}`, i.value)));
}

$('catchupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('formError');
  err.hidden = true;
  const fanType = document.querySelector('input[name="fanType"]:checked').value;
  const language = document.querySelector('input[name="language"]:checked').value;
  const body = state.source === 'sim'
    ? { source: 'sim', sinceOver: Number($('sinceSlider').value), fanType, language }
    : { source: 'paste', commentary: $('commentary').value, fanType, language };

  const btn = $('goBtn');
  btn.disabled = true;
  btn.textContent = 'Catching you up…';
  showSkeleton();
  const started = performance.now();
  try {
    const data = await api('/api/catchup', body);
    renderResult(data, language, ((performance.now() - started) / 1000).toFixed(1));
  } catch (ex) {
    $('result').hidden = true;
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Catch me up';
  }
});

function showSkeleton() {
  const r = $('result');
  r.hidden = false;
  r.replaceChildren(h('div', { class: 'skeleton w60' }), h('div', { class: 'skeleton w90' }), h('div', { class: 'skeleton w75' }), h('div', { class: 'skeleton w90' }));
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Result ---------- */
function refChips(refs) {
  if (!refs?.length) return null;
  return h('span', { class: 'refs' }, refs.map((r) => h('button', {
    type: 'button', class: 'ref', title: 'Show the original commentary line',
    onclick: (e) => {
      const host = e.target.closest('li, p');
      const existing = host.querySelector(`.ref-text[data-id="${CSS.escape(r.id)}"]`);
      if (existing) existing.remove();
      else host.append(h('span', { class: 'ref-text', 'data-id': r.id }, `${r.id}  ${r.text}`));
    },
  }, r.id)));
}

function wpBar(team, pct) {
  const fill = h('div', { class: 'wp-fill' });
  fill.style.width = `${pct}%`;
  return h('div', { class: 'wp' },
    h('div', { class: 'wp-labels' }, h('span', {}, `${team} ${pct}%`), h('span', {}, `${100 - pct}%`)),
    h('div', { class: 'wp-bar' }, fill));
}

function renderResult(d, language, secs) {
  const r = $('result');
  const L = HEADINGS[language] ?? HEADINGS.en;

  if (d.empty) {
    r.replaceChildren(h('p', { class: 'headline' }, 'You haven’t missed anything yet!'), h('p', { class: 'muted' }, 'Pick an earlier over, or wait for the next one.'));
    return;
  }

  const parts = [];
  if (d.source !== 'ai') parts.push(h('p', { class: 'note' }, h('span', { class: 'badge basic' }, 'BASIC RECAP · NO AI'), ' ', d.note));
  parts.push(h('p', { class: 'headline' }, d.headline));
  if (d.scoreLine) parts.push(h('p', { class: 'scoreline' }, d.scoreLine));

  if (d.winProb) {
    const w = d.winProb;
    parts.push(h('h3', {}, `${L.win} · ${w.basis === 'stats' ? 'rough stats model' : 'rough AI estimate'}`), wpBar(w.team, w.now));
    if (w.then !== null && w.then !== undefined) {
      const diff = w.now - w.then;
      parts.push(h('p', { class: 'wp-change' }, `When you left: ${w.then}% → now ${w.now}% (${diff >= 0 ? '+' : ''}${diff})`));
    }
  }

  parts.push(h('h3', {}, L.things), h('ol', { class: 'things' }, d.things.map((t) => h('li', {}, t.text, refChips(t.refs)))));
  if (d.turningPoint) parts.push(h('h3', {}, L.turning), h('p', {}, d.turningPoint.text, refChips(d.turningPoint.refs)));
  parts.push(h('h3', {}, L.next), h('p', {}, d.watchNext));

  parts.push(h('h3', {}, L.chat), h('div', { class: 'chatline' }, d.chatLine),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'ghost', onclick: () => share(d.chatLine, 'Line copied') }, L.copyLine),
      h('button', { type: 'button', class: 'ghost', onclick: () => share(recapText(d), 'Recap copied') }, L.copy)));

  if (d.poll) {
    parts.push(h('h3', {}, L.poll), pollView(d.poll));
    if (d.poll.shareable) {
      parts.push(h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost', onclick: (e) => sharePoll(d.poll.id, e.currentTarget) }, L.sharePoll)));
    }
  }

  parts.push(h('p', { class: 'muted small' }, `${d.source === 'ai' ? 'Written by AI (Gemini) from the match feed' : 'Built from the match feed without AI'} · ${secs}s · tap a ball number to see its commentary`));
  r.replaceChildren(...parts);
}

function pollView(p) {
  const total = p.counts.reduce((a, b) => a + b, 0);
  const voted = state.myVotes[p.id];
  return h('div', { class: 'poll', 'data-poll': p.id },
    h('p', { class: 'poll-q' }, p.question),
    p.options.map((opt, i) => {
      const pct = total ? Math.round((p.counts[i] / total) * 100) : 0;
      const bar = h('span', { class: 'bar' });
      bar.style.width = voted !== undefined ? `${pct}%` : '0';
      return h('button', { type: 'button', class: `poll-opt${voted === i ? ' mine' : ''}`, onclick: () => vote(p.id, i) },
        bar, h('span', { class: 'lbl' }, h('span', {}, opt), voted !== undefined ? h('span', {}, `${pct}%`) : null));
    }),
    h('p', { class: 'muted small' }, voted !== undefined ? `${total} vote${total === 1 ? '' : 's'} · just for fun` : 'Tap to vote · just for fun'));
}

async function vote(pollId, option) {
  try {
    const poll = await api(`/api/polls/${pollId}/vote`, { option, voterId: state.voterId });
    state.myVotes[pollId] = option;
    store.set('mi.votes', JSON.stringify(state.myVotes));
    updatePoll(poll);
  } catch (ex) { toast(ex.message); }
}

function updatePoll(p) {
  document.querySelectorAll(`[data-poll="${CSS.escape(p.id)}"]`).forEach((el) => el.replaceWith(pollView(p)));
}

async function sharePoll(pollId, btn) {
  try {
    addRoomItem(await api(`/api/polls/${pollId}/share`, {}));
    btn.disabled = true;
    toast('Poll shared in the watch room');
  } catch (ex) { toast(ex.message); }
}

function recapText(d) {
  const lines = [`🏏 ${d.headline}`];
  if (d.scoreLine) lines.push(d.scoreLine);
  d.things.forEach((t, i) => lines.push(`${i + 1}. ${t.text}`));
  if (d.turningPoint) lines.push(`🔁 ${d.turningPoint.text}`);
  lines.push(`👀 ${d.watchNext}`);
  if (d.winProb) lines.push(`📊 ${d.winProb.team} win chance ~${d.winProb.now}%`);
  lines.push(d.mode === 'sim' ? '— via Missed It? (simulated match)' : '— via Missed It?');
  return lines.join('\n');
}

// On phones, open the native share sheet (WhatsApp etc.); elsewhere, copy.
async function share(text, copiedMsg) {
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast(copiedMsg);
  } catch (ex) {
    if (ex.name !== 'AbortError') toast('Could not copy. Long-press the text to select it instead.');
  }
}

/* ---------- Watch room ---------- */
function renderReactionButtons(reactions) {
  $('reactions').replaceChildren(...reactions.map((label, i) => h('button', {
    type: 'button', class: 'react-btn',
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { addRoomItem(await api('/api/react', { reaction: i })); } catch (ex) { toast(ex.message); }
      setTimeout(() => { btn.disabled = false; }, 1500);
    },
  }, label)));
}

function addRoomItem(item) {
  const list = $('roomFeed');
  list.querySelector('.empty')?.remove();
  if (list.querySelector(`[data-item="${CSS.escape(item.id)}"]`)) return;
  const time = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  list.append(item.kind === 'poll'
    ? h('li', { 'data-item': item.id }, h('div', { class: 'who' }, `A fan shared a poll · ${time}`), pollView(item.poll))
    : h('li', { 'data-item': item.id, class: 'reaction' }, h('span', {}, item.text), h('span', { class: 'muted small' }, time)));
  while (list.children.length > 60) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

/* ---------- Boot ---------- */
(async function boot() {
  try {
    const s = await api('/api/state');
    renderScore(s.snapshot);
    renderReactionButtons(s.reactions);
    if (s.room.length) s.room.forEach(addRoomItem);
    else $('roomFeed').append(h('li', { class: 'empty' }, 'Quiet in here. Tap a reaction to get it going.'));
    if (!s.ai) toast('AI is off on this server. Showing basic recaps.');
  } catch {
    $('equation').textContent = 'Could not reach the server. Retrying…';
  }
  connect();
})();
