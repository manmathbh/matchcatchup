// Real end-to-end check of the AI path: npm run smoke
// Makes 3 small Gemini requests (English, Hinglish, Marathi), about 2k tokens in each.
// On the free tier they count toward your daily request quota.
// Never prints the API key.

import '../lib/env.js';
import { MatchEngine } from '../lib/matchEngine.js';
import { Room } from '../lib/room.js';
import { generateCatchup } from '../lib/catchup.js';
import { verifyKey } from '../lib/ai.js';

const DEVANAGARI = /[\u0900-\u097F]/;
const LATIN = /[A-Za-z]/;
const DEVANAGARI_DIGIT = /[\u0966-\u096F]/;

const CASES = [
  { language: 'en', fanType: 'casual', sinceOver: 9, langOk: (t) => !DEVANAGARI.test(t), langRule: 'English, no Devanagari' },
  { language: 'hinglish', fanType: 'beginner', sinceOver: 10, langOk: (t) => !DEVANAGARI.test(t) && LATIN.test(t), langRule: 'Roman-script Hinglish' },
  { language: 'mr', fanType: 'hardcore', sinceOver: 11, langOk: (t) => DEVANAGARI.test(t), langRule: 'Marathi in Devanagari' },
];

const line = (s = '') => console.log(s);

function fail(msg) {
  line(`\nFAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  line('Missed It? smoke test\n');

  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || ['your-gemini-key', 'your-key-here'].includes(key)) fail('GEMINI_API_KEY is missing from .env (or still the placeholder).');
  line('API key: present');

  const { on, why } = await verifyKey();
  line(`AI mode: ${on ? 'ON' : 'OFF'} (${why})`);
  if (!on) fail('Gemini did not accept the key. Check it in Google AI Studio (aistudio.google.com/apikey).');

  const engine = new MatchEngine({ startAtOver: 13 });
  engine.newMatch();
  const room = new Room();
  const s = engine.snapshot();
  line(`Test match: ${s.battingShort} ${s.score}/${s.wickets} after ${s.overs} overs, chasing ${s.target}\n`);

  const problems = [];
  for (const c of CASES) {
    const started = Date.now();
    const out = await generateCatchup({ engine, room, debug: true, input: { source: 'sim', sinceOver: c.sinceOver, fanType: c.fanType, language: c.language } });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const label = `${c.language} / ${c.fanType}`;

    if (out.source !== 'ai') {
      line(`[${label}] ${secs}s  used the basic recap. Reason: ${out.reason ?? 'unknown'}`);
      problems.push(`${label}: AI call failed (${out.reason ?? 'unknown'})`);
      continue;
    }

    const windowIds = new Set(engine.eventsSince(c.sinceOver).map((e) => e.id));
    const claims = [...out.things, out.turningPoint].filter(Boolean);
    const allCited = claims.every((cl) => cl.refs.length > 0 && cl.refs.every((r) => windowIds.has(r.id)));
    const { claims: total, dropped } = out.grounding;
    const text = [out.headline, ...out.things.map((t) => t.text), out.watchNext, out.chatLine, out.poll?.question ?? ''].join(' ');
    const langOk = c.langOk(text);

    line(`[${label}] ${secs}s`);
    line(`  headline: ${out.headline}`);
    line(`  every shown claim cites a real ball id: ${allCited ? 'yes' : 'NO'}`);
    line(`  claims dropped by the server: ${dropped} of ${total}`);
    const digitsOk = !DEVANAGARI_DIGIT.test(text);
    line(`  language (${c.langRule}): ${langOk ? 'ok' : 'WRONG'}`);
    line(`  numbers use digits 0-9 only: ${digitsOk ? 'yes' : 'NO'}\n`);

    if (!allCited) problems.push(`${label}: a shown claim lacks a valid ball id`);
    if (dropped > 1) problems.push(`${label}: server dropped ${dropped} ungrounded claims (expected 0–1)`);
    if (!langOk) problems.push(`${label}: output is not in ${c.langRule}`);
    if (!digitsOk) problems.push(`${label}: numbers contain Devanagari digits`);
    if (out.things.length < 2) problems.push(`${label}: only ${out.things.length} grounded claim(s)`);
  }

  if (problems.length) fail(`\n- ${problems.join('\n- ')}`);
  line('PASS: all three catch-ups came from Gemini, cited real balls and used the right language.');
}

main().catch(() => fail('Unexpected error while running the smoke test.'));
