import { z } from 'zod';
import { buildUserPrompt } from './prompt.js';
import { callAI, AiError } from './ai.js';
import { fallbackRecap } from './fallback.js';

export const MAX_COMMENTARY_CHARS = 6000;
const MAX_PASTE_LINES = 120;
const CACHE_MAX = 200;
const cache = new Map();

const BASIC = 'Basic recap built straight from the match feed, without AI.';
const FALLBACK_NOTES = {
  key: `AI is off on this server. ${BASIC}`,
  cap: `Today's AI limit has been reached. ${BASIC} AI recaps are back tomorrow.`,
  error: `The AI recap isn't available right now. ${BASIC}`,
};

// Gemini only gets responseMimeType=json (no schema), so accept harmless variations
// like numeric ball ids; the grounding check below still rejects ids not in the feed.
const ids = z.array(z.union([z.string(), z.number()]).transform(String)).default([]);
const modelOutput = z.object({
  headline: z.string(),
  three_things: z.array(z.object({ text: z.string(), event_ids: ids })),
  turning_point: z.object({ text: z.string(), event_ids: ids }),
  watch_next: z.string(),
  chat_line: z.string(),
  poll: z.object({ question: z.string(), options: z.array(z.string()) }),
  win_estimate: z.object({ team: z.string(), percent: z.coerce.number(), confident: z.boolean() }).optional(),
});

// Devanagari digits (०-९) become 0-9 so numbers never mix styles, e.g. "६6".
export const westernDigits = (s) => s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));

const clip = (s, n) => {
  const t = westernDigits(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function buildSimContext(engine, sinceOver) {
  const now = engine.snapshot();
  const since = Math.max(0, Math.min(sinceOver, now.completedOvers));
  const events = engine.eventsSince(since);
  const balls = events.filter((e) => e.kind !== 'over_end');
  const biggestSwing = balls.reduce((best, e) => (!best || Math.abs(e.swing) > Math.abs(best.swing) ? e : best), null);
  return {
    mode: 'sim',
    sinceOver: since,
    now,
    then: engine.stateAtOver(since),
    events,
    biggestSwing: biggestSwing && Math.abs(biggestSwing.swing) >= 3 ? biggestSwing : null,
    stats: {
      runs: balls.reduce((a, e) => a + e.runs, 0),
      wickets: balls.filter((e) => e.kind === 'wicket').length,
      fours: balls.filter((e) => e.kind === 'four').length,
      sixes: balls.filter((e) => e.kind === 'six').length,
    },
    cacheKey: `${now.matchId}|${since}|${engine.events.length}`,
  };
}

function buildPasteContext(commentary) {
  const lines = commentary
    .split(/\r?\n/)
    .map((l) => clip(l, 300))
    .filter(Boolean)
    .slice(-MAX_PASTE_LINES);
  return { mode: 'paste', events: lines.map((text, i) => ({ id: `L${i + 1}`, text })) };
}

// Keep only claims that point at real feed lines; attach the original lines as receipts.
function ground(raw, ctx) {
  const byId = new Map(ctx.events.map((e) => [e.id, e]));
  const refs = (ids) => [...new Set(ids)].filter((id) => byId.has(id)).slice(0, 4).map((id) => ({ id, text: byId.get(id).text }));

  const candidates = raw.three_things.slice(0, 3).map((t) => ({ text: clip(t.text, 220), refs: refs(t.event_ids) }));
  const things = candidates.filter((t) => t.text && t.refs.length);
  let turningPoint = { text: clip(raw.turning_point.text, 220), refs: refs(raw.turning_point.event_ids) };
  const tpGrounded = turningPoint.refs.length > 0;
  if (!tpGrounded) {
    turningPoint = ctx.biggestSwing ? { text: ctx.biggestSwing.text, refs: refs([ctx.biggestSwing.id]) } : null;
  }
  const options = raw.poll.options.map((o) => clip(o, 40)).filter(Boolean).slice(0, 3);

  return {
    headline: clip(raw.headline, 120),
    things,
    turningPoint,
    watchNext: clip(raw.watch_next, 220),
    chatLine: clip(raw.chat_line, 160),
    poll: options.length >= 2 ? { question: clip(raw.poll.question, 100), options } : null,
    winEstimate: raw.win_estimate,
    grounding: { claims: candidates.length + 1, dropped: candidates.length - things.length + (tpGrounded ? 0 : 1) },
  };
}

// `debug: true` (used only by the smoke test) adds the internal fallback reason.
export async function generateCatchup({ engine, room, input, debug = false }) {
  const ctx = input.source === 'paste' ? buildPasteContext(input.commentary) : buildSimContext(engine, input.sinceOver);
  if (!ctx.events.length) return { source: 'none', empty: true };

  const key = ctx.cacheKey && `${ctx.cacheKey}|${input.fanType}|${input.language}`;
  if (key && cache.has(key)) return withPoll({ ...cache.get(key), cached: true }, room, ctx);

  let out = null;
  let source = 'ai';
  let note = null;
  let reason = null;

  try {
    const raw = modelOutput.parse(await callAI(buildUserPrompt(ctx, input)));
    out = ground(raw, ctx);
    if (!out.things.length || !out.headline) throw new AiError('Model output was not grounded in the feed');
  } catch (err) {
    const kind = err instanceof AiError ? err.reason : 'error';
    if (kind === 'error') console.warn(`[catchup] AI fallback: ${err instanceof AiError ? err.message : 'invalid model output'}`);
    source = 'fallback';
    note = FALLBACK_NOTES[kind];
    reason = err instanceof AiError ? err.message : 'Model output failed validation';
    out = null;
  }
  out ??= ground(fallbackRecap(ctx, input), ctx);
  if (!out.things.length) out.things = [{ text: fallbackRecap(ctx, input).three_things[0].text, refs: [] }];

  const result = { source, note, mode: ctx.mode, ...out, ...winBlock(ctx, out.winEstimate) };
  delete result.winEstimate;
  if (source !== 'ai') delete result.grounding;
  if (ctx.mode === 'sim') {
    const s = ctx.now;
    result.scoreLine = `${s.battingShort} ${s.score}/${s.wickets} (${s.overs} ov)${s.status === 'done' ? ` · ${s.result}` : ` · need ${s.runsNeeded} off ${s.ballsLeft}`}`;
    result.missed = { fromOver: ctx.sinceOver, ...ctx.stats };
  }

  // Only AI results are cached, so a temporary failure doesn't stick.
  if (key && source === 'ai') {
    cache.set(key, result);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return withPoll(debug ? { ...result, reason } : result, room, ctx);
}

// Win chance: in sim mode always the stats model (the LLM never sets it).
// In paste mode, only the model's estimate when it says it's confident.
function winBlock(ctx, est) {
  if (ctx.mode === 'sim') {
    return { winProb: { team: ctx.now.battingShort, then: ctx.then.wp, now: ctx.now.wp, basis: 'stats' } };
  }
  if (est?.confident && est.team && est.percent >= 0 && est.percent <= 100) {
    return { winProb: { team: clip(est.team, 30), then: null, now: Math.round(est.percent), basis: 'ai' } };
  }
  return { winProb: null };
}

// Polls built from the simulated feed may be shared in the public room. Polls from
// pasted commentary stay private, so user-supplied text never reaches other viewers.
function withPoll(result, room, ctx) {
  if (!result.poll) return result;
  const poll = room.createPoll(result.poll.question, result.poll.options, { shareable: ctx.mode === 'sim' });
  return { ...result, poll };
}
