// Gemini REST API via fetch (no SDK). The key stays on the server and is
// never logged or put in an error message.

import { SYSTEM_PROMPT } from './prompt.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 30_000;
const DAILY_CAP = Math.max(0, Number(process.env.AI_DAILY_CAP ?? 300) || 0);

let keyRejected = false;
const usage = { day: null, calls: 0 };

export class AiError extends Error {
  constructor(message, reason = 'error') {
    super(message);
    this.reason = reason; // 'error' | 'cap' | 'key'
  }
}

const apiKey = () => process.env.GEMINI_API_KEY?.trim() ?? '';

// AI mode is on when a key is configured and the API hasn't rejected it.
export function aiEnabled() {
  return Boolean(apiKey()) && !keyRejected;
}

// The daily budget resets at midnight India time, when the audience's day starts.
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function takeBudget() {
  const d = today();
  if (usage.day !== d) Object.assign(usage, { day: d, calls: 0 });
  if (usage.calls >= DAILY_CAP) return false;
  usage.calls++;
  return true;
}

async function gemini(path, init = {}, attempt = 1) {
  try {
    return await fetch(`${API_BASE}/models/${encodeURIComponent(MODEL)}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey(), ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new AiError('Gemini API timed out');
    // The connection dropped before any reply (often a stale reused socket): retry once.
    if (attempt === 1) return gemini(path, init, 2);
    throw new AiError(`Could not reach the Gemini API (${err?.cause?.code ?? err?.cause?.name ?? 'network error'})`);
  }
}

// Gemini reports a bad key as 400 API_KEY_INVALID, or 401/403.
async function isKeyProblem(res) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status !== 400) return false;
  const body = await res.json().catch(() => null);
  return JSON.stringify(body?.error?.details ?? []).includes('API_KEY_INVALID');
}

// Free check at startup (model lookup, no tokens used): does the API accept the key?
export async function verifyKey() {
  if (!apiKey()) return { on: false, why: 'no GEMINI_API_KEY set' };
  try {
    const res = await gemini('');
    if (res.ok) return { on: true, why: `model ${MODEL}, daily cap ${DAILY_CAP}` };
    if (await isKeyProblem(res)) {
      keyRejected = true;
      return { on: false, why: 'API key was rejected' };
    }
    if (res.status === 404) return { on: true, why: `model "${MODEL}" not found; check GEMINI_MODEL` };
    return { on: true, why: `could not verify the key (HTTP ${res.status}); will try on first request` };
  } catch {
    return { on: true, why: 'could not reach the Gemini API to verify the key; will try on first request' };
  }
}

// Returns the parsed JSON object, or throws AiError (caller falls back to the rule-based recap).
export async function callAI(userPrompt) {
  if (!aiEnabled()) throw new AiError('AI mode is off', 'key');
  if (!takeBudget()) throw new AiError('Daily AI cap reached', 'cap');

  const res = await gemini(':generateContent', {
    method: 'POST',
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    if (await isKeyProblem(res)) {
      keyRejected = true;
      throw new AiError('API key rejected', 'key');
    }
    // 429 (quota / rate limit) and 5xx: AI unavailable right now.
    throw new AiError(`Gemini API error ${res.status}`);
  }

  const data = await res.json().catch(() => null);
  const candidate = data?.candidates?.[0];
  if (!candidate) throw new AiError(data?.promptFeedback?.blockReason ? 'Gemini blocked the request' : 'Gemini returned no answer');
  if (candidate.finishReason === 'MAX_TOKENS') throw new AiError('Gemini response was cut off');

  const text = candidate.content?.parts?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('Gemini returned invalid JSON');
  }
}
