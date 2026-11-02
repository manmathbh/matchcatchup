// Rule-based catch-up used when the Claude API is unavailable, slow, or declines.
// It is less fluent but built purely from feed events, so it can never invent anything.

const T = {
  en: {
    nothing: 'Nothing big happened while you were away.',
    headlineUp: (t, s) => `${t} take control — ${s}`,
    headlineDown: (t, s) => `${t} under pressure — ${s}`,
    headlineEven: (t, s) => `Still anyone's game — ${t} ${s}`,
    won: (r) => `Full time: ${r}`,
    next: (b, need, balls) => (b ? `Can ${b.name} (${b.runs} off ${b.balls}) see it through? ${need} needed off ${balls}.` : `${need} needed off ${balls}.`),
    chat: (s) => `Back! ${s} — what did I miss?! 🏏`,
    poll: (t) => `Will ${t} chase it down?`,
    yesNo: ['Yes, easily', 'Last-over finish', 'No chance'],
    pasteHead: 'Here is the latest from your commentary',
    pasteNext: 'Keep an eye on the next over.',
    pasteChat: 'Just caught up — this match is getting good! 🏏',
    pastePoll: 'Who wins this one?',
    pasteOpts: ['Batting side', 'Bowling side', 'Too close to call'],
  },
  hinglish: {
    nothing: 'Aapke jaane ke baad kuch bada nahi hua.',
    headlineUp: (t, s) => `${t} ka control — ${s}`,
    headlineDown: (t, s) => `${t} pressure mein — ${s}`,
    headlineEven: (t, s) => `Match abhi bhi khula hai — ${t} ${s}`,
    won: (r) => `Match khatam: ${r}`,
    next: (b, need, balls) => (b ? `Kya ${b.name} (${b.runs} off ${b.balls}) match khatam karenge? ${balls} balls mein ${need} chahiye.` : `${balls} balls mein ${need} chahiye.`),
    chat: (s) => `Wapas aa gaya! ${s} — kya miss kiya maine?! 🏏`,
    poll: (t) => `Kya ${t} target chase kar lenge?`,
    yesNo: ['Haan, aaram se', 'Last over tak jaayega', 'Bilkul nahi'],
    pasteHead: 'Aapki commentary ka latest update',
    pasteNext: 'Agle over pe nazar rakho.',
    pasteChat: 'Abhi catch up kiya — match mast chal raha hai! 🏏',
    pastePoll: 'Ye match kaun jeetega?',
    pasteOpts: ['Batting team', 'Bowling team', 'Kehna mushkil'],
  },
  mr: {
    nothing: 'तुम्ही नसताना फार काही मोठं घडलं नाही.',
    headlineUp: (t, s) => `${t} चं वर्चस्व — ${s}`,
    headlineDown: (t, s) => `${t} दबावात — ${s}`,
    headlineEven: (t, s) => `सामना अजून खुला — ${t} ${s}`,
    won: (r) => `सामना संपला: ${r}`,
    next: (b, need, balls) => (b ? `${b.name} (${b.balls} चेंडूत ${b.runs}) सामना जिंकून देईल का? ${balls} चेंडूत ${need} धावा हव्यात.` : `${balls} चेंडूत ${need} धावा हव्यात.`),
    chat: (s) => `परत आलो! ${s} — काय चुकवलं मी?! 🏏`,
    poll: (t) => `${t} लक्ष्य गाठतील का?`,
    yesNo: ['हो, सहज', 'शेवटच्या ओव्हरपर्यंत', 'अजिबात नाही'],
    pasteHead: 'तुमच्या कॉमेंट्रीतील ताजी अपडेट',
    pasteNext: 'पुढच्या ओव्हरवर लक्ष ठेवा.',
    pasteChat: 'आत्ताच कॅच-अप केलं — सामना रंगतोय! 🏏',
    pastePoll: 'हा सामना कोण जिंकेल?',
    pasteOpts: ['फलंदाजी करणारा संघ', 'गोलंदाजी करणारा संघ', 'सांगणं कठीण'],
  },
};

const IMPORTANCE = { wicket: 3, six: 2, four: 1 };

export function fallbackRecap(ctx, { language }) {
  const t = T[language] ?? T.en;

  if (ctx.mode === 'paste') {
    const last = ctx.events.slice(-3);
    return {
      headline: t.pasteHead,
      three_things: last.map((e) => ({ text: e.text, event_ids: [e.id] })),
      turning_point: { text: last.at(-1)?.text ?? '', event_ids: last.length ? [last.at(-1).id] : [] },
      watch_next: t.pasteNext,
      chat_line: t.pasteChat,
      poll: { question: t.pastePoll, options: t.pasteOpts },
    };
  }

  const s = ctx.now;
  const balls = ctx.events.filter((e) => e.kind !== 'over_end');
  const ranked = balls
    .map((e) => ({ e, score: Math.abs(e.swing) + (IMPORTANCE[e.kind] ?? 0) * 3 }))
    .filter((x) => x.score > 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.e)
    .sort((a, b) => ctx.events.indexOf(a) - ctx.events.indexOf(b));

  const scoreLine = `${s.battingShort} ${s.score}/${s.wickets} (${s.overs})`;
  const delta = s.wp - ctx.then.wp;
  const ahead = s.wp >= 65 || (s.wp > 35 && delta >= 10);
  const behind = s.wp <= 35 || (s.wp < 65 && delta <= -10);
  const headline =
    s.status === 'done' ? t.won(s.result) : ahead ? t.headlineUp(s.battingShort, scoreLine) : behind ? t.headlineDown(s.battingShort, scoreLine) : t.headlineEven(s.battingShort, `${s.score}/${s.wickets}`);
  const tp = ctx.biggestSwing;

  return {
    headline,
    three_things: ranked.length ? ranked.map((e) => ({ text: e.text, event_ids: [e.id] })) : [{ text: t.nothing, event_ids: [] }],
    turning_point: tp ? { text: tp.text, event_ids: [tp.id] } : { text: t.nothing, event_ids: [] },
    watch_next: s.status === 'done' ? t.won(s.result) : t.next(s.striker, s.runsNeeded, s.ballsLeft),
    chat_line: t.chat(scoreLine),
    poll: { question: t.poll(s.battingShort), options: t.yesNo },
  };
}
