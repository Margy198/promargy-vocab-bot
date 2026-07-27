// Telegram-бот "Словарный квиз" для promargy.com
// Формат: квиз с 4 вариантами перевода, кнопки под сообщением.
// Работает как Netlify Function (webhook), состояние и сам словарь хранятся
// в Netlify Blobs — отдельного сервера или базы данных не нужно.
//
// Словарь можно пополнять прямо из Telegram, без редеплоя:
//   - просто вставь в чат с ботом одну или несколько строк вида "English . перевод"
//   - или используй /add <строка>
//   - /delete <English> удаляет слово
//   - /count показывает, сколько слов сейчас в базе
//
// Все обновления состояния (счёт и словарь) идут через безопасное к гонкам
// чтение-изменение-запись (ETag + onlyIfMatch), чтобы два почти одновременных
// нажатия кнопки не затирали прогресс друг друга.

import { getStore } from "@netlify/blobs";
import { VOCAB as DEFAULT_VOCAB } from "../../data/vocab.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET; // опционально, но рекомендуется
const API = `https://api.telegram.org/bot${TOKEN}`;

// consistency: "strong" — по умолчанию Netlify Blobs "eventually consistent"
// (запись может долетать до чтения до 60 секунд), из-за чего самое первое
// нажатие кнопки иногда "не находило" только что записанный вопрос. Строгая
// консистентность чуть медленнее, но гарантирует, что запись видна сразу же.
const pendingStore = () => getStore("vocab-bot-pending", { consistency: "strong" });
const statsStore = () => getStore("vocab-bot-stats", { consistency: "strong" });
const wordsStore = () => getStore("vocab-bot-words", { consistency: "strong" });
const debugStore = () => getStore("vocab-bot-debug", { consistency: "strong" });
const rateLimitStore = () => getStore("vocab-bot-ratelimit", { consistency: "strong" });

// Telegram официально рекомендует не больше ~1 сообщения в секунду в один и
// тот же чат — при превышении сообщение не отклоняется (наш вызов API
// получает "ok"), а тихо откладывается на стороне Telegram и доставляется
// клиенту позже. Это может объяснять "второй вопрос не приходит сразу":
// если отвечать быстрее раза в секунду, каждое следующее сообщение рискует
// попасть в такую отложенную доставку. Выдерживаем паузу перед отправкой,
// если предыдущее сообщение в этот чат ушло меньше секунды назад.
const MIN_MS_BETWEEN_MESSAGES = process.env.RATE_LIMIT_MS != null ? parseInt(process.env.RATE_LIMIT_MS, 10) : 1100;

async function waitForRateLimit(chatId) {
  const key = String(chatId);
  const last = await rateLimitStore().get(key, { type: "json" });
  const now = Date.now();
  if (last && typeof last.at === "number") {
    const elapsed = now - last.at;
    if (elapsed < MIN_MS_BETWEEN_MESSAGES) {
      await new Promise((resolve) => setTimeout(resolve, MIN_MS_BETWEEN_MESSAGES - elapsed));
    }
  }
}

async function markMessageSent(chatId) {
  try {
    await rateLimitStore().setJSON(String(chatId), { at: Date.now() });
  } catch (err) {
    // Не критично, если запись не удалась — просто следующий вызов
    // подождёт чуть дольше, чем нужно.
  }
}

// Собственный маленький журнал отладки в Blobs — не зависит от того, работает
// ли сейчас просмотр логов в самой панели Netlify. Хранит последние 150
// записей. Читается через GET-запрос к этой же функции с ?debug=<секрет>.
async function dbg(msg) {
  try {
    const key = "log";
    const existing = await debugStore().getWithMetadata(key, { type: "json" });
    const arr = existing && Array.isArray(existing.data) ? existing.data : [];
    arr.push(`${new Date().toISOString()} ${msg}`);
    while (arr.length > 150) arr.shift();
    try {
      if (existing) {
        await debugStore().setJSON(key, arr, { onlyIfMatch: existing.etag });
      } else {
        await debugStore().setJSON(key, arr, { onlyIfNew: true });
      }
    } catch (err) {
      // Конфликт записи — не критично для отладочного журнала, просто пишем как есть.
      await debugStore().setJSON(key, arr);
    }
  } catch (err) {
    // Отладочное логирование никогда не должно ронять бота.
    console.error("dbg() failed:", err);
  }
}

const CYR = /[а-яёА-ЯЁ]/;
const LAT = /[A-Za-z]/;

function emptyStats() {
  return { answered: 0, correct: 0, streak: 0, bestStreak: 0, wrong: {}, recentEn: [] };
}

async function log(...args) {
  console.log(...args);
  await dbg(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}

// Безопасное к гонкам обновление: читаем текущее значение вместе с ETag,
// применяем mutate(), и пишем обратно только "если ничего не изменилось
// с момента чтения" (onlyIfMatch). Если кто-то другой успел записать
// раньше нас — перечитываем и пробуем снова.
async function withOptimisticUpdate(store, key, defaultValue, mutate, maxAttempts = 6) {
  let lastComputed;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const existing = await store.getWithMetadata(key, { type: "json" });
    const current = existing ? existing.data : defaultValue();
    const updated = mutate(current);
    lastComputed = updated;
    try {
      if (existing) {
        await store.setJSON(key, updated, { onlyIfMatch: existing.etag });
      } else {
        await store.setJSON(key, updated, { onlyIfNew: true });
      }
      return updated;
    } catch (err) {
      // Конфликт (кто-то записал раньше нас) — перечитываем и пробуем снова.
      if (attempt === maxAttempts - 1) {
        console.error("withOptimisticUpdate: giving up after retries, forcing write", key, err);
        await store.setJSON(key, updated);
        return updated;
      }
    }
  }
  return lastComputed;
}

async function getStats(chatId) {
  const s = await statsStore().get(String(chatId), { type: "json" });
  return s || emptyStats();
}

// --- Словарь: хранится в Blobs, при первом запуске сеется из data/vocab.mjs ---

async function getVocab() {
  const v = await wordsStore().get("words", { type: "json" });
  if (Array.isArray(v) && v.length) return v;
  try {
    await wordsStore().setJSON("words", DEFAULT_VOCAB, { onlyIfNew: true });
  } catch (err) {
    // Кто-то другой уже засеял словарь параллельно с нами — не страшно,
    // просто читаем то, что получилось, ниже.
  }
  return getVocab_retryOnce();
}

async function getVocab_retryOnce() {
  const v = await wordsStore().get("words", { type: "json" });
  return Array.isArray(v) && v.length ? v : DEFAULT_VOCAB;
}

// Разбирает одну строку вида "English term . перевод" (разделители: . - — – → = ->)
// в пару {en, ru}. Делит по языку, а не по конкретному символу — так надёжнее
// на разношёрстных заметках с уроков.
//
// Важно: соседние куски ОДНОГО языка склеиваются обратно с исходным разделителем
// между ними (а не одним пробелом) — иначе "Sing - sang - sung" превратилось бы
// в "Sing sang sung" (потеряли дефисы) и не совпало бы с уже сохранённой записью
// при повторном добавлении того же слова.
function parseVocabLine(raw) {
  let line = raw.trim();
  if (!line) return null;
  line = line.replace(/^[-*•\u2022\d]+[.)]?\s*/, "").trim(); // убрать буллиты/нумерацию
  if (!line) return null;

  const SEP_RE = /(\s+(?:->|—|–|→|=|\.|-)\s+)/;
  const parts = line.split(SEP_RE);
  if (parts.length < 3) return null; // нет ни одного разделителя

  const runs = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i].trim();
    if (!text) continue;
    const isRu = CYR.test(text);
    const isEn = LAT.test(text) && !isRu;
    const lang = isRu ? "ru" : isEn ? "en" : null;
    const sepBefore = i > 0 ? parts[i - 1].trim() : "";
    const last = runs[runs.length - 1];
    if (last && last.lang === lang && lang !== null) {
      last.text += ` ${sepBefore} ${text}`;
    } else {
      runs.push({ lang, text });
    }
  }

  const enRuns = runs.filter((r) => r.lang === "en").map((r) => r.text.trim());
  const ruRuns = runs.filter((r) => r.lang === "ru").map((r) => r.text.trim());
  if (!enRuns.length || !ruRuns.length) return null;
  return { en: enRuns.join(" ").trim(), ru: ruRuns.join(", ").trim() };
}

// Добавляет распарсенные пары в словарь, пропуская дубли (по english, без учёта регистра).
// Устойчиво к гонкам: если словарь параллельно поменяли (например, ты добавляешь
// слова, а кто-то в этот же момент отвечает на вопрос и т.п.), просто повторяем попытку.
async function addWords(pairs) {
  let added = 0;
  let total = 0;
  await withOptimisticUpdate(
    wordsStore(),
    "words",
    () => DEFAULT_VOCAB,
    (vocab) => {
      const next = [...vocab];
      const seen = new Set(next.map((w) => w.en.toLowerCase()));
      added = 0;
      for (const p of pairs) {
        const key = p.en.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(p);
        added += 1;
      }
      total = next.length;
      return next;
    }
  );
  return { added, total };
}

async function deleteWord(term) {
  let removed = false;
  let total = 0;
  await withOptimisticUpdate(
    wordsStore(),
    "words",
    () => DEFAULT_VOCAB,
    (vocab) => {
      const before = vocab.length;
      const next = vocab.filter((w) => w.en.toLowerCase() !== term);
      removed = next.length !== before;
      total = next.length;
      return next;
    }
  );
  return { removed, total };
}

async function tg(method, payload) {
  // Пауза, чтобы не слать больше ~1 сообщения в секунду в один и тот же чат
  // (см. комментарий у MIN_MS_BETWEEN_MESSAGES) — применяется ко всем
  // sendMessage-вызовам автоматически, не только к вопросам.
  if (method === "sendMessage" && payload && payload.chat_id != null) {
    await waitForRateLimit(payload.chat_id);
  }

  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    await log(`[tg:${method}] FAILED status=${res.status}`, JSON.stringify(data), "payload:", JSON.stringify(payload));
  } else {
    await log(`[tg:${method}] ok`);
    if (method === "sendMessage" && payload && payload.chat_id != null) {
      await markMessageSent(payload.chat_id);
    }
  }
  return data;
}

// На случай если в словаре попадутся символы Markdown (*, _, [, `) —
// чтобы бот не падал с ошибкой форматирования у Telegram.
function mdEscape(s) {
  return String(s).replace(/([_*`[])/g, "\\$1");
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Подбирает несколько неверных вариантов, у которых и перевод, и слово
// отличаются от правильного и друг от друга (чтобы не было двух одинаковых кнопок).
function pickDistractors(vocab, correctWord, count) {
  const usedRu = new Set([correctWord.ru.toLowerCase().trim()]);
  const usedEn = new Set([correctWord.en.toLowerCase().trim()]);
  const chosen = [];
  let attempts = 0;
  while (chosen.length < count && attempts < 300 && chosen.length < vocab.length - 1) {
    attempts++;
    const w = vocab[Math.floor(Math.random() * vocab.length)];
    const ru = w.ru.toLowerCase().trim();
    const en = w.en.toLowerCase().trim();
    if (usedEn.has(en) || usedRu.has(ru)) continue;
    usedRu.add(ru);
    usedEn.add(en);
    chosen.push(w);
  }
  return chosen;
}

// Слова, в которых человек недавно ошибался, чаще попадаются повторно —
// но не среди последних 50 показанных слов (excludeSet), чтобы одно и то же
// слово не всплывало слишком часто, а разнообразие ощущалось на большом окне.
function pickQuestionWord(vocab, stats, excludeSet) {
  const pool = excludeSet && excludeSet.size ? vocab.filter((v) => !excludeSet.has(v.en)) : vocab;
  const candidates = pool.length ? pool : vocab;

  const wrongWords = Object.keys(stats.wrong || {}).filter((w) => !excludeSet || !excludeSet.has(w));
  if (wrongWords.length && Math.random() < 0.35) {
    const enKey = wrongWords[Math.floor(Math.random() * wrongWords.length)];
    const w = candidates.find((v) => v.en === enKey);
    if (w) return w;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

const RECENT_HISTORY_SIZE = 50;
const OPTIONS_COUNT = 6; // 1 правильный + 5 неверных вариантов

async function sendQuestion(chatId, stats, prefix) {
  const vocab = await getVocab();
  if (!vocab.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Словарь сейчас пуст. Вставь сюда слова в формате «English . перевод», и я начну спрашивать.",
    });
    return;
  }

  const excludeSet = new Set(Array.isArray(stats.recentEn) ? stats.recentEn : []);
  const correct = pickQuestionWord(vocab, stats, excludeSet);
  const distractors = pickDistractors(vocab, correct, Math.min(OPTIONS_COUNT - 1, vocab.length - 1));
  const options = shuffle([correct, ...distractors]);
  const correctPos = options.indexOf(correct);
  const keyboard = options.map((o, i) => [{ text: o.ru, callback_data: `a:${i}` }]);

  const questionText = `🎯 Как переводится: *${mdEscape(correct.en)}*?`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;

  const result = await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });

  // Запоминаем, к какому конкретно сообщению относится вопрос — если позже
  // придёт нажатие на кнопку СТАРОГО сообщения (пользователь проскроллил
  // историю и ткнул в прошлый вопрос), мы это заметим и не засчитаем его
  // как ответ на текущий вопрос.
  const messageId = result && result.result ? result.result.message_id : undefined;
  await log(`[sendQuestion] new question="${correct.en}" messageId=${messageId} sendMessage.ok=${result && result.ok}`);

  await pendingStore().setJSON(String(chatId), {
    correctEn: correct.en,
    correctRu: correct.ru,
    correctPos,
    consumed: false,
    messageId,
  });

  // Пополняем историю последних 50 показанных слов — устойчиво к гонкам.
  await withOptimisticUpdate(statsStore(), String(chatId), emptyStats, (current) => {
    const s = { ...current };
    const hist = Array.isArray(s.recentEn) ? [...s.recentEn] : [];
    hist.push(correct.en);
    while (hist.length > RECENT_HISTORY_SIZE) hist.shift();
    s.recentEn = hist;
    return s;
  });
}

function statsLine(stats) {
  const acc = stats.answered ? Math.round((100 * stats.correct) / stats.answered) : 0;
  return `Счёт: ${stats.correct}/${stats.answered} (${acc}%) · 🔥 серия: ${stats.streak} · рекорд: ${stats.bestStreak}`;
}

async function handleStart(chatId) {
  const stats = await getStats(chatId);
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "Привет! Это тренажёр лексики 🎓\n\n" +
      "Показываю слово или фразу — выбираешь перевод из 4 вариантов. " +
      "Слова, в которых ошибаешься, будут попадаться чаще.\n\n" +
      "Чтобы добавить новые слова — просто вставь сюда строки вида «English . перевод» " +
      "(можно сразу много строк за раз), я сама их разберу.\n\n" +
      "Команды: /play, /score, /count, /delete <слово>, /reset, /help",
  });
  await sendQuestion(chatId, stats);
}

async function handleHelp(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "/play — новый вопрос\n" +
      "/score — статистика\n" +
      "/count — сколько слов в словаре\n" +
      "/delete <English> — удалить слово\n" +
      "/reset — сбросить прогресс (счёт/серию)\n\n" +
      "Чтобы добавить слова — просто пришли строки вида «English . перевод», " +
      "хоть одну, хоть весь список с урока сразу.",
  });
}

async function handleScore(chatId) {
  const stats = await getStats(chatId);
  const missed = Object.entries(stats.wrong || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, c]) => `  • ${w} (${c})`)
    .join("\n");
  await tg("sendMessage", {
    chat_id: chatId,
    text: `📊 ${statsLine(stats)}` + (missed ? `\n\nЧаще всего путаешь:\n${missed}` : ""),
  });
}

async function handleReset(chatId) {
  await withOptimisticUpdate(statsStore(), String(chatId), emptyStats, () => emptyStats());
  await tg("sendMessage", { chat_id: chatId, text: "Прогресс сброшен. /play — начать заново." });
}

async function handleCount(chatId) {
  const vocab = await getVocab();
  await tg("sendMessage", { chat_id: chatId, text: `В словаре сейчас ${vocab.length} слов.` });
}

async function handleDelete(chatId, argText) {
  const term = argText.trim().toLowerCase();
  if (!term) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /delete English word" });
    return;
  }
  const { removed, total } = await deleteWord(term);
  if (!removed) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${argText.trim()}» в словаре.` });
    return;
  }
  await tg("sendMessage", { chat_id: chatId, text: `Удалила «${argText.trim()}». Осталось ${total} слов.` });
}

// Любой не-командный текст (или явный /add) пытаемся распарсить как одну
// или несколько пар "слово - перевод" и добавить в словарь.
async function handleBulkAdd(chatId, text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  const badLines = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseVocabLine(line);
    if (parsed) pairs.push(parsed);
    else badLines.push(line.trim());
  }

  if (!pairs.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        "Не нашла ни одной пары «слово - перевод». Формат: English . перевод " +
        "(можно вставить сразу много строк).",
    });
    return;
  }

  const { added, total } = await addWords(pairs);
  const skippedDupes = pairs.length - added;
  let msg = `✅ Добавлено новых слов: ${added}. Всего в словаре: ${total}.`;
  if (skippedDupes) msg += `\nПропущено как дубли: ${skippedDupes}.`;
  if (badLines.length) {
    msg += `\nНе распознано строк: ${badLines.length}${badLines.length <= 5 ? " — " + badLines.join(" | ") : ""}.`;
  }
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

// Пытается "забрать" текущий вопрос для обработки ровно один раз: если два
// запроса (например, из-за повторной доставки Telegram или очень быстрого
// повторного нажатия) придут почти одновременно, обработает его только тот,
// кто успеет записать consumed:true первым — второй получит null и не будет
// засчитывать ответ повторно.
//
// Также проверяет, что нажатие пришло именно с того сообщения, к которому
// относится текущий вопрос — если пользователь проскроллил историю и ткнул
// кнопку у старого (уже неактуального) вопроса, это не должно попасть в
// текущий счёт.
async function claimPending(chatId, messageId) {
  const store = pendingStore();
  const key = String(chatId);
  const existing = await store.getWithMetadata(key, { type: "json" });
  if (!existing || !existing.data || existing.data.consumed) return null;
  if (existing.data.messageId != null && existing.data.messageId !== messageId) return null;
  try {
    await store.setJSON(key, { ...existing.data, consumed: true }, { onlyIfMatch: existing.etag });
    return existing.data;
  } catch (err) {
    return null;
  }
}

async function handleCallback(callbackQuery) {
  // Отвечаем на нажатие СРАЗУ, первым делом — до любых обращений к Blobs и
  // Telegram API. Раньше это делалось в конце, и на холодном старте функции
  // вся цепочка (чтение/запись состояния, отправка сообщений) иногда не
  // укладывалась в то время, что Telegram ждёт ответ по кнопке — отсюда
  // бесконечные "часики" на первом нажатии (второе срабатывало, потому что
  // функция была уже "прогрета"). Информативный текст (✅/❌ и перевод) всё
  // равно приходит в отредактированном сообщении ниже, поэтому в самом тосте
  // текст не дублируем.
  await log("[callback] received", JSON.stringify({ id: callbackQuery.id, data: callbackQuery.data, hasMessage: !!callbackQuery.message }));
  await tg("answerCallbackQuery", { callback_query_id: callbackQuery.id });
  await log("[callback] step1: answerCallbackQuery done");

  if (!callbackQuery.message) {
    await log("[callback] no message on callback_query — stopping (old/inline message)");
    return;
  }

  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  if (data === "start") {
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats);
    return;
  }

  if (!data || !data.startsWith("a:")) {
    await log("[callback] unrecognized data, stopping:", data);
    return;
  }
  const chosenIdx = parseInt(data.slice(2), 10);

  const pending = await claimPending(chatId, messageId);
  await log("[callback] step2: claimPending result:", JSON.stringify(pending));
  if (!pending) {
    await log("[callback] could not claim pending (stale/duplicate) — stopping here");
    return;
  }

  const isCorrect = chosenIdx === pending.correctPos;
  await log(`[callback] step3: chosenIdx=${chosenIdx} correctPos=${pending.correctPos} isCorrect=${isCorrect}`);

  const stats = await withOptimisticUpdate(statsStore(), String(chatId), emptyStats, (current) => {
    const s = { ...current, wrong: { ...current.wrong } };
    s.answered += 1;
    if (isCorrect) {
      s.correct += 1;
      s.streak += 1;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      delete s.wrong[pending.correctEn];
    } else {
      s.streak = 0;
      s.wrong[pending.correctEn] = (s.wrong[pending.correctEn] || 0) + 1;
    }
    return s;
  });
  await log("[callback] step4: stats updated:", JSON.stringify(stats));

  const resultText = `${isCorrect ? "✅" : "❌"} *${mdEscape(pending.correctEn)}* — ${mdEscape(pending.correctRu)}\n\n${statsLine(stats)}`;

  await sendQuestion(chatId, stats, resultText);
  await log("[callback] step5: sendQuestion (with result prefix) done — handling complete");
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  if (text === "/start") return handleStart(chatId);
  if (text === "/play" || text === "/next") {
    const stats = await getStats(chatId);
    return sendQuestion(chatId, stats);
  }
  if (text === "/score" || text === "/stats") return handleScore(chatId);
  if (text === "/reset") return handleReset(chatId);
  if (text === "/count") return handleCount(chatId);
  if (text === "/help") return handleHelp(chatId);
  if (/^\/delete(@\w+)?\s*/i.test(text)) {
    return handleDelete(chatId, text.replace(/^\/delete(@\w+)?\s*/i, ""));
  }
  if (/^\/add(@\w+)?\s*/i.test(text)) {
    return handleBulkAdd(chatId, text.replace(/^\/add(@\w+)?\s*/i, ""));
  }
  if (text.startsWith("/")) {
    return tg("sendMessage", { chat_id: chatId, text: "Не знаю такую команду. /help — список команд." });
  }

  // любой обычный текст — пробуем разобрать как новые слова
  return handleBulkAdd(chatId, text);
}

const seenUpdatesStore = () => getStore("vocab-bot-seen-updates", { consistency: "strong" });

// Telegram может доставить один и тот же update дважды (например, если наш
// ответ пришёл чуть медленнее обычного). Помечаем update_id как обработанный
// атомарно (onlyIfNew) — если это уже второй раз, просто ничего не делаем
// повторно, вместо того чтобы второй раз слать вопрос/команду.
async function claimUpdateOnce(updateId) {
  if (updateId == null) return true; // нет update_id — не с чем сверяться, работаем как обычно
  try {
    await seenUpdatesStore().set(String(updateId), "1", { onlyIfNew: true });
    return true;
  } catch (err) {
    return false; // уже видели этот update — это повторная доставка
  }
}

export default async (req) => {
  if (req.method !== "POST") {
    // GET ?debug=<секрет> — отдаёт последние записи собственного журнала
    // отладки, независимо от того, работает ли сейчас просмотр логов в
    // самой панели Netlify.
    if (req.method === "GET" && WEBHOOK_SECRET) {
      const url = new URL(req.url);
      if (url.searchParams.get("debug") === WEBHOOK_SECRET) {
        const entries = await debugStore().get("log", { type: "json" });
        return new Response(JSON.stringify(entries || [], null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }
    return new Response("ok", { status: 200 });
  }

  if (WEBHOOK_SECRET) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const isFirstTimeSeeingThisUpdate = await claimUpdateOnce(body.update_id);
  if (!isFirstTimeSeeingThisUpdate) {
    // Повторная доставка того же update — уже обработали, просто отвечаем ok.
    return new Response("ok", { status: 200 });
  }

  try {
    if (body.callback_query) {
      await handleCallback(body.callback_query);
    } else if (body.message) {
      await handleMessage(body.message);
    }
  } catch (err) {
    await log("[handler] UNCAUGHT ERROR:", String(err), err && err.stack);
  }

  // Telegram ждёт быстрый ответ 200 — иначе будет слать вебхук повторно
  return new Response("ok", { status: 200 });
};

export const config = { path: "/telegram-webhook" };
