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
const identityStore = () => getStore("vocab-bot-identities", { consistency: "strong" });
const adminStore = () => getStore("vocab-bot-admins", { consistency: "strong" });

// Секретное слово для самостоятельного получения прав администратора —
// команда /claimadmin <секрет>. Кто пришлёт верный секрет, тот сразу
// становится админом (без переписки с разработчиком и без передеплоя).
// Секрет можно передать и другому человеку (например, помощнику), если ему
// тоже нужен доступ к /students.
const CLAIM_ADMIN_SECRET = "GCfVjhtMz9-wJSgQ";

async function isAdmin(chatId) {
  const v = await adminStore().get(String(chatId), { type: "json" });
  return !!v;
}

// Запоминаем, кто стоит за этим чатом (имя/username из Telegram), чтобы
// потом можно было отличить одного ученика от другого в /students.
// Не критично для работы бота — если не получится записать, просто молча
// продолжаем.
async function rememberIdentity(chatId, from) {
  if (!from) return;
  try {
    const existing = await identityStore().get(String(chatId), { type: "json" });
    await identityStore().setJSON(String(chatId), {
      ...(existing || {}),
      firstName: from.first_name || "",
      lastName: from.last_name || "",
      username: from.username || "",
      lastSeen: new Date().toISOString(),
    });
  } catch (err) {
    // не критично
  }
}

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
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await debugStore().getWithMetadata("log", { type: "json" });
      const arr = existing && Array.isArray(existing.data) ? existing.data : [];
      arr.push(`${new Date().toISOString()} ${msg}`);
      while (arr.length > 150) arr.shift();
      try {
        if (existing) {
          await debugStore().setJSON("log", arr, { onlyIfMatch: existing.etag });
        } else {
          await debugStore().setJSON("log", arr, { onlyIfNew: true });
        }
        return;
      } catch (err) {
        if (attempt === 9) throw err;
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 30));
      }
    }
  } catch (err) {
    // Отладочное логирование никогда не должно ронять бота — но теперь хотя
    // бы не теряет записи молча при конфликте, а честно повторяет попытку.
    console.error("dbg() failed after retries:", err);
  }
}

const CYR = /[а-яёА-ЯЁ]/;
const LAT = /[A-Za-z]/;

function emptyStats() {
  return { answered: 0, correct: 0, streak: 0, bestStreak: 0, wrong: {} };
}

async function log(...args) {
  console.log(...args);
  await dbg(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}

// Безопасное к гонкам обновление: читаем текущее значение вместе с ETag,
// применяем mutate(), и пишем обратно только "если ничего не изменилось
// с момента чтения" (onlyIfMatch). Если кто-то другой успел записать
// раньше нас — перечитываем и пробуем снова, с небольшой случайной паузой,
// чтобы конкурирующие попытки не сталкивались раз за разом синхронно.
//
// Важно: раньше после исчерпания попыток был "аварийный" безусловный
// force-write — он мог тихо затереть более свежие данные, записанные кем-то
// параллельно. Теперь при исчерпании попыток бросаем ошибку — это безопаснее:
// лучше один раз не обработать нажатие, чем незаметно испортить прогресс.
//
// (Была ещё попытка добавить перечитывание-и-сверку после каждой записи —
// откатила: сама проверка могла попадать в ту же задержку консистентности,
// из-за чего вместо редкого "слово застряло" бот иногда переставал отвечать
// вовсе, натыкаясь на таймаут функции. Пока просто доверяем ответу "ok" от
// самой записи.)
async function withOptimisticUpdate(store, key, defaultValue, mutate, maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const existing = await store.getWithMetadata(key, { type: "json" });
    const current = existing ? existing.data : defaultValue();
    const updated = mutate(current);
    try {
      if (existing) {
        await store.setJSON(key, updated, { onlyIfMatch: existing.etag });
      } else {
        await store.setJSON(key, updated, { onlyIfNew: true });
      }
      return updated;
    } catch (err) {
      if (attempt === maxAttempts - 1) {
        throw new Error(`withOptimisticUpdate: giving up on "${key}" after ${maxAttempts} attempts: ${err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 90));
    }
  }
}

// Как и выше — без блокирующей перепроверки, просто доверяем ответу записи.
// Проверка ограничена (максимум 3 попытки, короткая фиксированная пауза) —
// в отличие от прежней версии withOptimisticUpdate, эта запись не является
// общим ключом, за который конкурируют несколько запросов одновременно
// (только "победитель" claimPending когда-либо пишет сюда за один раз),
// поэтому здесь бесконечный цикл повторов из-за постоянной конкуренции не
// грозит — можно позволить себе разумную перепроверку.
async function verifiedSet(store, key, value, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await store.setJSON(key, value);
    const verify = await store.get(key, { type: "json" });
    if (JSON.stringify(verify) === JSON.stringify(value)) return;
    if (attempt < maxAttempts - 1) {
      await log(`[verifiedSet] mismatch on "${key}" (attempt ${attempt}) — retrying`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await log(`[verifiedSet] still mismatched on "${key}" after ${maxAttempts} attempts — proceeding with last write anyway`);
}

async function getStats(chatId) {
  const s = await statsStore().get(String(chatId), { type: "json" });
  return s || emptyStats();
}

// --- Словарь: хранится в Blobs ОТДЕЛЬНО ДЛЯ КАЖДОГО ЧАТА (каждый ученик
// видит и редактирует только свой собственный список слов), при первом
// обращении сеется из data/vocab.mjs. ---

async function getVocab(chatId) {
  const key = `words:${chatId}`;
  const v = await wordsStore().get(key, { type: "json" });
  if (Array.isArray(v) && v.length) return v;
  try {
    await wordsStore().setJSON(key, DEFAULT_VOCAB, { onlyIfNew: true });
  } catch (err) {
    // Кто-то другой уже засеял словарь параллельно с нами — не страшно,
    // просто читаем то, что получилось, ниже.
  }
  return getVocab_retryOnce(chatId);
}

async function getVocab_retryOnce(chatId) {
  const v = await wordsStore().get(`words:${chatId}`, { type: "json" });
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
    // Кусок в /слэшах/ обычно фонетическая транскрипция ("Signature
    // /сигначэ/", "Now /naʊ/") — она может быть написана кириллицей и
    // сбивать определение языка (весь кусок выглядел бы "русским" из-за
    // неё). Для определения языка её не учитываем, но сохраняем как есть.
    const withoutPhonetic = text.replace(/\/[^/]*\//g, " ").trim();
    const langCheckText = withoutPhonetic || text;
    const isRu = CYR.test(langCheckText);
    const isEn = LAT.test(langCheckText) && !isRu;
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
async function addWords(chatId, pairs) {
  let added = 0;
  let total = 0;
  await withOptimisticUpdate(
    wordsStore(),
    `words:${chatId}`,
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

async function deleteWord(chatId, term) {
  let removed = false;
  let total = 0;
  await withOptimisticUpdate(
    wordsStore(),
    `words:${chatId}`,
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

// Из строки вида "English. перевод" / "English . перевод" / просто "English"
// достаёт именно английскую часть — для удаления не важен точный формат
// разделителя, только по какому слову искать.
function extractEnForDelete(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const idxSpaceDot = trimmed.indexOf(" . ");
  if (idxSpaceDot > 0) return trimmed.slice(0, idxSpaceDot).trim();
  const idxDot = trimmed.indexOf(". ");
  if (idxDot > 0) return trimmed.slice(0, idxDot).trim();
  return trimmed;
}

// Удаляет сразу несколько слов (по одному на строку, в любом из форматов
// выше) одной атомарной операцией.
async function deleteWords(chatId, terms) {
  const termSet = new Set(terms.map((t) => t.toLowerCase()));
  let removedCount = 0;
  let total = 0;
  await withOptimisticUpdate(
    wordsStore(),
    `words:${chatId}`,
    () => DEFAULT_VOCAB,
    (vocab) => {
      const before = vocab.length;
      const next = vocab.filter((w) => !termSet.has(w.en.toLowerCase()));
      removedCount = before - next.length;
      total = next.length;
      return next;
    }
  );
  return { removedCount, total };
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
// Используется только на "случайном" этапе (когда новых непройденных слов
// больше нет) — см. pickQuestionWord ниже.
function pickRandomQuestionWord(vocab, wrongMap, excludeSet) {
  const pool = excludeSet && excludeSet.size ? vocab.filter((v) => !excludeSet.has(v.en)) : vocab;
  const candidates = pool.length ? pool : vocab;

  const wrongWords = Object.keys(wrongMap || {}).filter((w) => !excludeSet || !excludeSet.has(w));
  if (wrongWords.length && Math.random() < 0.35) {
    const enKey = wrongWords[Math.floor(Math.random() * wrongWords.length)];
    const w = candidates.find((v) => v.en === enKey);
    if (w) return w;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Выбор слова для вопроса, в два этапа:
//  1) Пока есть слова, которые этот пользователь ЕЩЁ НИ РАЗУ не видел —
//     показываем их первыми, начиная с добавленных САМЫМИ ПОСЛЕДНИМИ, и по
//     возможности не из последних 50 показанных (excludeSet).
//  2) Когда пользователь прошёл весь словарь хотя бы по разу — начинается
//     "перемешанный" круг: случайный выбор, но каждое слово в пределах
//     круга не повторяется, пока не пройдут все остальные. По завершении
//     круга (seenEn сбрасывается) начинается заново.
// seenEnSet передаётся явно (не из общего хранилища счёта) — см. комментарий
// у buildQuestion ниже про то, откуда он теперь берётся.
function pickQuestionWord(vocab, wrongMap, seenEnSet, excludeSet) {
  const unseen = vocab.filter((v) => !seenEnSet.has(v.en));
  const unseenAndNotRecent = excludeSet && excludeSet.size ? unseen.filter((v) => !excludeSet.has(v.en)) : unseen;

  if (unseenAndNotRecent.length) {
    return { word: unseenAndNotRecent[unseenAndNotRecent.length - 1], resetCycle: false };
  }

  if (unseen.length) {
    return { word: unseen[unseen.length - 1], resetCycle: false };
  }

  return { word: pickRandomQuestionWord(vocab, wrongMap, excludeSet), resetCycle: true };
}

const RECENT_HISTORY_SIZE = 50;
const OPTIONS_COUNT = 6; // 1 правильный + 5 неверных вариантов

// Чистая функция: выбирает следующее слово и собирает текст/клавиатуру
// вопроса, ничего не читая и не записывая в хранилище.
//
// ВАЖНО (архитектурное решение после долгой отладки): историю "какие слова
// уже показаны" (seenEnList/recentTailList) мы теперь передаём СНАРУЖИ, а не
// читаем из общего хранилища счёта (stats). Общее хранилище счёта — это
// один и тот же ключ, в который постоянно пишут при каждом ответе, и на
// практике запись туда иногда не успевала долететь до следующего чтения
// (несмотря на "строгую" консистентность) — из-за этого слово могло
// "забыть", что его уже показывали, и вылезти повторно раньше, чем через
// 50 вопросов. У записи текущего вопроса (pendingStore) такой проблемы не
// наблюдалось за всё время отладки — она проще (одна перезапись, не
// read-modify-write под конкуренцией), поэтому историю теперь тоже носим
// вместе с pending, из рук в руки: каждый новый вопрос сохраняет свою
// версию истории, а следующий её просто забирает оттуда, без отдельного
// похода в другое хранилище.
function buildQuestion(vocab, wrongMap, prefix, forbiddenEn, seenEnList, recentTailList) {
  const seenEnSet = new Set(Array.isArray(seenEnList) ? seenEnList : []);
  const tail = Array.isArray(recentTailList) ? recentTailList : [];
  // Ограничиваем окно исключения так, чтобы оно не могло охватить ВЕСЬ
  // словарь (иначе, при маленьком словаре, единственным вариантом снова
  // стало бы то же самое только что показанное слово).
  const maxExclude = Math.max(0, vocab.length - 1);
  const excludeSet = new Set(tail.slice(-maxExclude));
  if (forbiddenEn) excludeSet.add(forbiddenEn);

  let { word: correct, resetCycle } = pickQuestionWord(vocab, wrongMap, seenEnSet, excludeSet);

  // Железная гарантия, не зависящая от хранилища: forbiddenEn — это слово,
  // которое только что отвечали, мы его знаем напрямую из текущего запроса.
  // Если по любой причине выбор всё равно совпал — принудительно берём
  // любое другое слово, лишь бы не повторить его сразу.
  if (forbiddenEn && correct.en === forbiddenEn && vocab.length > 1) {
    const alternatives = vocab.filter((w) => w.en !== forbiddenEn);
    correct = alternatives[Math.floor(Math.random() * alternatives.length)];
  }

  const distractors = pickDistractors(vocab, correct, Math.min(OPTIONS_COUNT - 1, vocab.length - 1));
  const options = shuffle([correct, ...distractors]);
  const correctPos = options.indexOf(correct);
  const keyboard = options.map((o, i) => [{ text: o.ru, callback_data: `a:${i}` }]);
  const questionText = `🎯 Как переводится: *${mdEscape(correct.en)}*?`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;

  const newSeenEn = resetCycle ? [correct.en] : seenEnSet.has(correct.en) ? seenEnList || [] : [...(seenEnList || []), correct.en];
  const newTail = [...tail, correct.en].slice(-RECENT_HISTORY_SIZE);

  return { correct, correctPos, keyboard, text, resetCycle, newSeenEn, newTail };
}

// Отправляет уже выбранный вопрос и запоминает pending — используется и из
// sendQuestion (одиночный вызов), и из handleCallback (после совмещённого
// обновления счёта+истории). История (newSeenEn/newTail) уходит в саму
// запись pending — см. комментарий у buildQuestion.
async function deliverQuestion(chatId, picked) {
  const result = await tg("sendMessage", {
    chat_id: chatId,
    text: picked.text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: picked.keyboard },
  });

  // Запоминаем, к какому конкретно сообщению относится вопрос — если позже
  // придёт нажатие на кнопку СТАРОГО сообщения (пользователь проскроллил
  // историю и ткнул в прошлый вопрос), мы это заметим и не засчитаем его
  // как ответ на текущий вопрос.
  const messageId = result && result.result ? result.result.message_id : undefined;
  await log(`[deliverQuestion] new question="${picked.correct.en}" messageId=${messageId} sendMessage.ok=${result && result.ok}`);

  await verifiedSet(pendingStore(), String(chatId), {
    correctEn: picked.correct.en,
    correctRu: picked.correct.ru,
    correctPos: picked.correctPos,
    consumed: false,
    messageId,
    seenEn: picked.newSeenEn,
    recentTail: picked.newTail,
  });
}

// Одиночная отправка вопроса (без одновременного обновления счёта) — для
// /start и /play. Историю берём из предыдущего pending, если он есть
// (надёжно, без похода в общее хранилище счёта).
async function sendQuestion(chatId, stats, prefix) {
  const vocab = await getVocab(chatId);
  if (!vocab.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Словарь сейчас пуст. Вставь сюда слова в формате «English . перевод», и я начну спрашивать.",
    });
    return;
  }

  const prevPending = await pendingStore().get(String(chatId), { type: "json" });
  const seenEnList = prevPending && Array.isArray(prevPending.seenEn) ? prevPending.seenEn : [];
  const recentTailList = prevPending && Array.isArray(prevPending.recentTail) ? prevPending.recentTail : [];

  const picked = buildQuestion(vocab, stats.wrong, prefix, null, seenEnList, recentTailList);
  await deliverQuestion(chatId, picked);
}

function statsLine(practicedCount, totalCount) {
  return `📚 ${practicedCount}/${totalCount} слов отработано`;
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
      "/delete <English> — удалить слово (можно сразу список, по одному на строку)\n" +
      "/reset — сбросить прогресс\n\n" +
      "Чтобы добавить слова — просто пришли строки вида «English . перевод», " +
      "хоть одну, хоть весь список с урока сразу.",
  });
}

async function handleScore(chatId) {
  const stats = await getStats(chatId);
  const vocab = await getVocab(chatId);
  const pending = await pendingStore().get(String(chatId), { type: "json" });
  const practicedCount = pending && Array.isArray(pending.seenEn) ? pending.seenEn.length : 0;
  const missed = Object.entries(stats.wrong || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, c]) => `  • ${w} (${c})`)
    .join("\n");
  await tg("sendMessage", {
    chat_id: chatId,
    text: `📊 ${statsLine(practicedCount, vocab.length)}` + (missed ? `\n\nЧаще всего путаешь:\n${missed}` : ""),
  });
}

async function handleReset(chatId) {
  await withOptimisticUpdate(statsStore(), String(chatId), emptyStats, () => emptyStats());
  await tg("sendMessage", { chat_id: chatId, text: "Прогресс сброшен. /play — начать заново." });
}

async function handleCount(chatId) {
  const vocab = await getVocab(chatId);
  await tg("sendMessage", { chat_id: chatId, text: `В словаре сейчас ${vocab.length} слов.` });
}

// Разовая команда для перехода на приватные (по чату) словари: раньше был
// один общий словарь на всех, кто писал боту. Тот, кто хочет унаследовать
// прежний общий список как свой личный (обычно нужно только один раз, в
// одном конкретном чате), может явно об этом попросить командой /migrate.
// Ничего не делает, если старого общего словаря уже нет или у этого чата
// уже есть свой список.
async function handleMigrate(chatId) {
  const existing = await wordsStore().get(`words:${chatId}`, { type: "json" });
  if (Array.isArray(existing) && existing.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `У этого чата уже есть свой словарь (${existing.length} слов) — переносить нечего.`,
    });
    return;
  }

  const legacy = await wordsStore().get("words", { type: "json" });
  if (!Array.isArray(legacy) || !legacy.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Старого общего словаря не нашла — переносить нечего." });
    return;
  }

  await verifiedSet(wordsStore(), `words:${chatId}`, legacy);
  await tg("sendMessage", { chat_id: chatId, text: `Готово — перенесла ${legacy.length} слов из старого общего словаря в этот чат.` });
}

// Только для админов (см. /claimadmin): полностью очищает словарь ДРУГОГО
// чата по его chat_id (посмотреть можно в /students). После очистки у того
// человека при следующем вопросе словарь пересеется заново стандартным
// стартовым набором — это ожидаемо, не баг.
async function handleClearVocab(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const targetId = argText.trim();
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /clearvocab <chat_id> (посмотреть chat_id — в /students)" });
    return;
  }
  const before = await wordsStore().get(`words:${targetId}`, { type: "json" });
  const count = Array.isArray(before) ? before.length : 0;
  await verifiedSet(wordsStore(), `words:${targetId}`, []);
  await tg("sendMessage", { chat_id: chatId, text: `Готово — очистила словарь чата ${targetId} (было ${count} слов).` });
}

// Находит chat_id по @username (ищет среди всех известных личностей) или,
// если передали просто число, использует его как chat_id напрямую.
async function resolveTarget(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const username = trimmed.replace(/^@/, "").toLowerCase();
  if (!username) return null;
  const ids = await identityStore().list();
  const entries = ids && ids.blobs ? ids.blobs : [];
  for (const entry of entries) {
    const info = await identityStore().get(entry.key, { type: "json" });
    if (info && info.username && info.username.toLowerCase() === username) {
      return entry.key;
    }
  }
  return null;
}

// Только для админов: добавляет слова НЕ в свой словарь, а в словарь
// конкретного другого ученика. Первая строка — @username или chat_id
// получателя, дальше — слова в обычном формате «English . перевод», можно
// сразу много строк.
async function handleAddTo(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText.split(/\r?\n/);
  const targetRaw = (lines[0] || "").trim();
  if (!targetRaw) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/addto @username (или chat_id)\nEnglish . перевод\n... (можно много строк)",
    });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }

  const pairs = [];
  for (const line of lines.slice(1)) {
    const parsed = parseVocabLine(line);
    if (parsed) pairs.push(parsed);
  }
  if (!pairs.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одной пары «слово - перевод» после первой строки." });
    return;
  }

  const { added, total } = await addWords(targetId, pairs);
  const skippedDupes = pairs.length - added;
  let msg = `✅ Добавлено в словарь ${targetRaw}: ${added}. Всего у него в словаре: ${total}.`;
  if (skippedDupes) msg += `\nПропущено как дубли: ${skippedDupes}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

async function handleDelete(chatId, argText) {
  const lines = argText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат: /delete English word (или вставь сразу несколько строк, каждую с новой строки).",
    });
    return;
  }

  if (lines.length === 1) {
    const term = extractEnForDelete(lines[0]).toLowerCase();
    const { removed, total } = await deleteWord(chatId, term);
    if (!removed) {
      await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${lines[0]}» в словаре.` });
      return;
    }
    await tg("sendMessage", { chat_id: chatId, text: `Удалила «${lines[0]}». Осталось ${total} слов.` });
    return;
  }

  const terms = lines.map(extractEnForDelete).filter(Boolean);
  const { removedCount, total } = await deleteWords(chatId, terms);
  const notFound = terms.length - removedCount;
  let msg = `🗑 Удалено слов: ${removedCount}. Осталось в словаре: ${total}.`;
  if (notFound > 0) msg += `\nНе нашла: ${notFound}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
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

  const { added, total } = await addWords(chatId, pairs);
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
  await log(`[callback] step3: word="${pending.correctEn}" chosenIdx=${chosenIdx} correctPos=${pending.correctPos} isCorrect=${isCorrect}`);

  const vocab = await getVocab(chatId);
  const seenEnList = Array.isArray(pending.seenEn) ? pending.seenEn : [];
  const recentTailList = Array.isArray(pending.recentTail) ? pending.recentTail : [];
  let picked = null;
  let statsAfter = null;

  await withOptimisticUpdate(statsStore(), String(chatId), emptyStats, (current) => {
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

    const resultText = `${isCorrect ? "✅" : "❌"} *${mdEscape(pending.correctEn)}* — ${mdEscape(pending.correctRu)}\n\n${statsLine(seenEnList.length, vocab.length)}`;

    if (vocab.length) {
      picked = buildQuestion(vocab, s.wrong, resultText, pending.correctEn, seenEnList, recentTailList);
    }

    statsAfter = s;
    return s;
  });
  await log("[callback] step4: stats+next-question picked in one transaction:", JSON.stringify(statsAfter));

  if (picked) {
    await deliverQuestion(chatId, picked);
  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Словарь сейчас пуст. Вставь сюда слова в формате «English . перевод», и я начну спрашивать.",
    });
  }
  await log("[callback] step5: question delivered — handling complete");
}

// Шлёт сообщение всем, кто сейчас является админом (см. /claimadmin) — на
// данный момент используется только для уведомлений о новых пользователях.
async function notifyAdmins(text) {
  try {
    const ids = await adminStore().list();
    const entries = ids && ids.blobs ? ids.blobs : [];
    for (const entry of entries) {
      await tg("sendMessage", { chat_id: entry.key, text });
    }
  } catch (err) {
    // не критично — отсутствие уведомления не должно ронять бота
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const existingIdentity = await identityStore().get(String(chatId), { type: "json" });
  const isBrandNewChat = !existingIdentity;
  await rememberIdentity(chatId, message.from);

  if (isBrandNewChat) {
    const from = message.from || {};
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "без имени";
    const uname = from.username ? ` (@${from.username})` : "";
    await notifyAdmins(`👋 Новый пользователь бота: ${name}${uname}, chat_id ${chatId}`);
  }

  // Если человек только что написал /register без текста — бот ждёт от
  // него имя следующим сообщением. Перехватываем это здесь, раньше любых
  // других команд/разбора слов.
  const identity = await identityStore().get(String(chatId), { type: "json" });
  if (identity && identity.awaitingRegisterName) {
    if (!text) {
      await tg("sendMessage", { chat_id: chatId, text: "Напиши, пожалуйста, своё имя текстом." });
      return;
    }
    await identityStore().setJSON(String(chatId), { ...identity, registeredName: text, awaitingRegisterName: false });
    await tg("sendMessage", { chat_id: chatId, text: `Спасибо, ${text}! Записала.` });
    return;
  }

  if (text === "/start") return handleStart(chatId);
  if (text === "/whoami") {
    await tg("sendMessage", { chat_id: chatId, text: `Твой chat_id: ${chatId}` });
    return;
  }
  if (/^\/claimadmin(@\w+)?\s*/i.test(text)) {
    const provided = text.replace(/^\/claimadmin(@\w+)?\s*/i, "").trim();
    if (!provided || provided !== CLAIM_ADMIN_SECRET) {
      await tg("sendMessage", { chat_id: chatId, text: "Неверный секрет." });
      return;
    }
    await adminStore().setJSON(String(chatId), { grantedAt: new Date().toISOString() });
    await tg("sendMessage", { chat_id: chatId, text: "Готово — теперь тебе доступна команда /students." });
    return;
  }
  if (/^\/register(@\w+)?\s*/i.test(text)) {
    const label = text.replace(/^\/register(@\w+)?\s*/i, "").trim();
    if (!label) {
      await identityStore().setJSON(String(chatId), { ...(identity || {}), awaitingRegisterName: true });
      await tg("sendMessage", { chat_id: chatId, text: "Как тебя записать? Напиши своё имя следующим сообщением." });
      return;
    }
    await identityStore().setJSON(String(chatId), { ...(identity || {}), registeredName: label, awaitingRegisterName: false });
    await tg("sendMessage", { chat_id: chatId, text: `Готово, записала: ${label}` });
    return;
  }
  if (text === "/students") {
    if (!(await isAdmin(chatId))) {
      await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
      return;
    }
    const ids = await identityStore().list();
    const entries = ids && ids.blobs ? ids.blobs : [];
    if (!entries.length) {
      await tg("sendMessage", { chat_id: chatId, text: "Пока никто не писал боту." });
      return;
    }
    const lines = [];
    for (const entry of entries) {
      const info = await identityStore().get(entry.key, { type: "json" });
      const studentChatId = entry.key;
      const vocab = await getVocab(studentChatId);
      const name = (info && info.registeredName) || (info ? [info.firstName, info.lastName].filter(Boolean).join(" ") : "");
      const uname = info && info.username ? ` (@${info.username})` : "";
      lines.push(`• ${name || "без имени"}${uname} — ${vocab.length} слов, chat_id ${studentChatId}`);
    }
    await tg("sendMessage", { chat_id: chatId, text: `Ученики (${entries.length}):\n${lines.join("\n")}` });
    return;
  }
  if (text === "/play" || text === "/next") {
    const stats = await getStats(chatId);
    return sendQuestion(chatId, stats);
  }
  if (text === "/score" || text === "/stats") return handleScore(chatId);
  if (text === "/reset") return handleReset(chatId);
  if (text === "/count") return handleCount(chatId);
  if (text === "/migrate") return handleMigrate(chatId);
  if (/^\/clearvocab(@\w+)?\s*/i.test(text)) {
    return handleClearVocab(chatId, text.replace(/^\/clearvocab(@\w+)?\s*/i, ""));
  }
  if (/^\/addto(@\w+)?\s*/i.test(text)) {
    return handleAddTo(chatId, text.replace(/^\/addto(@\w+)?\s*/i, ""));
  }
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
