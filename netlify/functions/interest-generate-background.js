// Фоновая генерация предложений по «своей теме» ученика (Netlify background function,
// до 15 минут). Вызывается из telegram-webhook (requestCustomInterest) и пишет
// результат в Blobs: interest:custom:<slug> = { status: "ready", title, emoji, sentences[] }.
// Нужны переменные окружения: ANTHROPIC_API_KEY (обязательно), ANTHROPIC_MODEL (необязательно),
// TELEGRAM_WEBHOOK_SECRET (защита от чужих вызовов).
import { getStore } from "@netlify/blobs";

const store = () => getStore("vocab-bot-course", { consistency: "strong" });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const PROMPT = (name) => `Ты помогаешь преподавателю английского. Напиши банк предложений для русскоязычного взрослого ученика по теме «${name}».

Верни ТОЛЬКО JSON без пояснений, ровно такой формы:
{"title":"<название темы по-русски, 1–3 слова>","emoji":"<один эмодзи>","sentences":[{"level":"A2","en":"...","ru":"...","vocab":[{"en":"...","ru":"..."},{"en":"...","ru":"..."}]}]}

Требования:
- 24 предложения: 8 уровня A2, 8 уровня B1, 8 уровня B2 (поле level), в таком порядке.
- en: живой современный английский по теме, 7–16 слов, разная грамматика (вопросы, отрицания, разные времена, модальные, фразовые глаголы). A2 — простое бытовое, B1 — типичные ситуации, B2 — нюансы и идиомы.
- ru: естественный перевод всего предложения.
- vocab: 2 самых полезных слова/словосочетания из предложения; en — ТОЧНО та форма, что стоит в предложении (подстрока), ru — значение в этом контексте. Не брать тривиальные слова.
- Лексика не повторяется между предложениями.`;

function validate(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.sentences)) return "no sentences";
  const ss = d.sentences.filter((s) => s && ["A2", "B1", "B2"].includes(s.level) && typeof s.en === "string" && typeof s.ru === "string" && Array.isArray(s.vocab));
  const good = ss.map((s) => ({ level: s.level, en: s.en.trim(), ru: s.ru.trim(), vocab: s.vocab.filter((v) => v && v.en && v.ru && s.en.toLowerCase().includes(String(v.en).toLowerCase())).slice(0, 3).map((v) => ({ en: String(v.en).trim(), ru: String(v.ru).trim() })) })).filter((s) => s.en.split(" ").length >= 5 && s.vocab.length);
  if (good.length < 12) return `only ${good.length} valid sentences`;
  return { title: String(d.title || "").slice(0, 40), emoji: String(d.emoji || "✨").slice(0, 4), sentences: good };
}

export default async (req) => {
  let body = {};
  try { body = await req.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (secret && body.secret !== secret) return new Response("forbidden", { status: 403 });
  const { name, slug } = body;
  if (!name || !slug || !/^[a-zа-я0-9-]{1,40}$/i.test(slug)) return new Response("bad request", { status: 400 });
  const key = `interest:custom:${slug}`;
  const fail = async (error) => { await store().setJSON(key, { status: "error", name, error, at: new Date().toISOString() }); return new Response("error", { status: 200 }); };
  if (!process.env.ANTHROPIC_API_KEY) return fail("no api key");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, messages: [{ role: "user", content: PROMPT(name) }] }),
    });
    const data = await r.json();
    if (!r.ok) return fail(`api ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
    const text = (data.content || []).map((c) => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return fail("no json in reply");
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch (e) { return fail("json parse: " + e.message); }
    const v = validate(parsed);
    if (typeof v === "string") return fail(v);
    await store().setJSON(key, { status: "ready", name, title: v.title || name, emoji: v.emoji, sentences: v.sentences, model: MODEL, at: new Date().toISOString() });
    return new Response("ok", { status: 200 });
  } catch (e) {
    return fail(String((e && e.message) || e));
  }
};
