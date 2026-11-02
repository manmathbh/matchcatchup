import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, OUTPUT_SCHEMA } from './prompt.js';

const MODEL = process.env.MISSEDIT_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.MISSEDIT_EFFORT || 'low'; // a 20-second catch-up should be fast
const DAILY_CAP = Math.max(0, Number(process.env.AI_DAILY_CAP ?? 300) || 0);

let client = null;
let keyRejected = false;
const usage = { day: null, calls: 0 };

export class AiError extends Error {
  constructor(message, reason = 'error') {
    super(message);
    this.reason = reason; // 'error' | 'cap' | 'key'
  }
}

const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim());

// AI mode is on when a key is configured and the API hasn't rejected it.
export function aiEnabled() {
  return hasKey() && !keyRejected;
}

function getClient() {
  client ??= new Anthropic({ timeout: 30_000, maxRetries: 1 });
  return client;
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

// Free check at startup (no tokens used): does the API accept the key?
// Logs only on/off and a reason — never the key itself.
export async function verifyKey() {
  if (!hasKey()) return { on: false, why: 'no ANTHROPIC_API_KEY set' };
  try {
    await getClient().models.retrieve(MODEL);
    return { on: true, why: `model ${MODEL}, daily cap ${DAILY_CAP}` };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      keyRejected = true;
      return { on: false, why: 'API key was rejected' };
    }
    return { on: true, why: `could not reach the API to verify the key (${err.status ?? 'network'}); will try on first request` };
  }
}

// Returns the parsed JSON object, or throws AiError (caller falls back to the rule-based recap).
export async function callClaude(userPrompt) {
  if (!aiEnabled()) throw new AiError('AI mode is off', 'key');
  if (!takeBudget()) throw new AiError('Daily AI cap reached', 'cap');

  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      // If a safety classifier declines, let the API retry on its recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      keyRejected = true;
      throw new AiError('API key rejected', 'key');
    }
    if (err instanceof Anthropic.RateLimitError) throw new AiError('Claude API rate limit hit');
    if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AiError('Claude API timed out');
    if (err instanceof Anthropic.APIError) throw new AiError(`Claude API error ${err.status ?? 'network'}`);
    throw new AiError('Claude API call failed');
  }

  if (response.stop_reason === 'refusal') throw new AiError('Model declined the request');
  if (response.stop_reason === 'max_tokens') throw new AiError('Model response was cut off');

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('Model returned invalid JSON');
  }
}
