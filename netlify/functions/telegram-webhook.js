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
const sharedLibraryStore = () => getStore("vocab-bot-shared-library", { consistency: "strong" });

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
// видит и редактирует только свой собственный список слов). У нового чата
// словарь пустой (0 слов) — раньше сеялся стартовым набором из
// data/vocab.mjs, но это был просто список слов ОДНОГО конкретного
// человека из ранних тестов бота, и не должен доставаться всем по
// умолчанию. Прежний общий словарь всё ещё доступен через /migrate, если
// кому-то он нужен явно. ---

async function getVocab(chatId) {
  const v = await wordsStore().get(`words:${chatId}`, { type: "json" });
  return Array.isArray(v) ? v : [];
}

// --- Общая библиотека (Quizlet-блок): одна и та же лексика видна ВСЕМ
// ученикам, отдельно от личного словаря каждого. Организована в два
// уровня — сложность (например "A1-A2") и тема внутри неё (например
// "медицина") — оба уровня свободный текст, задаёт сама Маргарита при
// добавлении. Хранится в отдельном Blobs-сторе, ключ вида
// "shared:<сложность>:<тема>" (оба слагаются в нижний регистр для
// единообразия), значение — как обычно, массив {en, ru}. ---

function slugifyLevel(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function sharedKey(difficulty, topic) {
  return `shared:${slugifyLevel(difficulty)}:${slugifyLevel(topic)}`;
}

async function getSharedVocab(difficulty, topic) {
  const v = await sharedLibraryStore().get(sharedKey(difficulty, topic), { type: "json" });
  return Array.isArray(v) ? v : [];
}

async function addSharedWords(difficulty, topic, pairs) {
  let added = 0;
  let total = 0;
  await withOptimisticUpdate(
    sharedLibraryStore(),
    sharedKey(difficulty, topic),
    () => [],
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

async function deleteSharedWords(difficulty, topic, terms) {
  let removedCount = 0;
  let total = 0;
  const termSet = new Set(terms.map((t) => t.toLowerCase().trim()));
  await withOptimisticUpdate(
    sharedLibraryStore(),
    sharedKey(difficulty, topic),
    () => [],
    (vocab) => {
      const next = vocab.filter((w) => !termSet.has(w.en.toLowerCase().trim()));
      removedCount = vocab.length - next.length;
      total = next.length;
      return next;
    }
  );
  return { removedCount, total };
}

// Возвращает список всех непустых пар "сложность/тема" в общей библиотеке
// вместе с человекочитаемыми исходными названиями (не только слагами) и
// количеством слов — используется и для меню ученика, и для /sharedlist.
async function listSharedLibrary() {
  const list = await sharedLibraryStore().list({ prefix: "shared:" });
  const entries = list && list.blobs ? list.blobs : [];
  const result = [];
  for (const entry of entries) {
    const parts = entry.key.split(":");
    if (parts.length !== 3) continue;
    const vocab = await sharedLibraryStore().get(entry.key, { type: "json" });
    const count = Array.isArray(vocab) ? vocab.length : 0;
    if (count === 0) continue;
    result.push({ difficultySlug: parts[1], topicSlug: parts[2], count });
  }
  return result;
}

// Разбирает одну строку вида "English term . перевод" (разделители: . - — – → = ->)

// Стартовый набор общей библиотеки (загружен Маргаритой единоразово,
// уровень A2, 10 тем, 400 слов) — подгружается автоматически один раз
// после деплоя (см. .github/workflows/seed-shared-library.yml), так что
// вручную отправлять эти слова боту не нужно. Повторные запуски безопасны
// (addSharedWords сам пропускает дубли).
const SEED_SHARED_LIBRARY_A2 = {
  difficulty: "A2",
  topics: {
    "путешествия": [
      { en: "journey", ru: "путешествие / дорога" },
      { en: "holiday", ru: "отпуск / каникулы" },
      { en: "flight", ru: "рейс" },
      { en: "luggage", ru: "багаж" },
      { en: "suitcase", ru: "чемодан" },
      { en: "backpack", ru: "рюкзак" },
      { en: "return ticket", ru: "билет туда и обратно" },
      { en: "single ticket", ru: "билет в одну сторону" },
      { en: "boarding pass", ru: "посадочный талон" },
      { en: "gate", ru: "выход на посадку" },
      { en: "departure", ru: "отправление" },
      { en: "arrival", ru: "прибытие" },
      { en: "delay", ru: "задержка" },
      { en: "to check in", ru: "регистрироваться" },
      { en: "to board", ru: "садиться (на рейс)" },
      { en: "platform", ru: "платформа" },
      { en: "to catch a train", ru: "успеть на поезд" },
      { en: "to miss a train", ru: "опоздать на поезд" },
      { en: "to change trains", ru: "делать пересадку" },
      { en: "abroad", ru: "за границей" },
      { en: "destination", ru: "пункт назначения" },
      { en: "to book", ru: "бронировать" },
      { en: "reservation", ru: "бронь" },
      { en: "to cancel", ru: "отменять" },
      { en: "hostel", ru: "хостел" },
      { en: "double room", ru: "двухместный номер" },
      { en: "to pack", ru: "собирать вещи" },
      { en: "guidebook", ru: "путеводитель" },
      { en: "sightseeing", ru: "осмотр достопримечательностей" },
      { en: "tourist", ru: "турист" },
      { en: "souvenir", ru: "сувенир" },
      { en: "seaside", ru: "морское побережье" },
      { en: "resort", ru: "курорт" },
      { en: "to sunbathe", ru: "загорать" },
      { en: "to go camping", ru: "ходить в поход с палаткой" },
      { en: "travel insurance", ru: "страховка для путешествий" },
      { en: "currency", ru: "валюта" },
      { en: "to exchange money", ru: "обменять деньги" },
      { en: "view", ru: "вид" },
      { en: "to have a good time", ru: "хорошо провести время" },
    ],
    "здоровье": [
      { en: "head", ru: "голова" },
      { en: "face", ru: "лицо" },
      { en: "neck", ru: "шея" },
      { en: "throat", ru: "горло" },
      { en: "chest", ru: "грудь" },
      { en: "stomach", ru: "живот / желудок" },
      { en: "back", ru: "спина" },
      { en: "shoulder", ru: "плечо" },
      { en: "arm", ru: "рука (от плеча)" },
      { en: "elbow", ru: "локоть" },
      { en: "wrist", ru: "запястье" },
      { en: "hand", ru: "кисть руки" },
      { en: "finger", ru: "палец руки" },
      { en: "leg", ru: "нога" },
      { en: "knee", ru: "колено" },
      { en: "ankle", ru: "лодыжка" },
      { en: "foot", ru: "ступня" },
      { en: "toe", ru: "палец ноги" },
      { en: "skin", ru: "кожа" },
      { en: "bone", ru: "кость" },
      { en: "heart", ru: "сердце" },
      { en: "illness", ru: "болезнь" },
      { en: "disease", ru: "заболевание" },
      { en: "headache", ru: "головная боль" },
      { en: "sore throat", ru: "боль в горле" },
      { en: "cough", ru: "кашель" },
      { en: "fever", ru: "высокая температура" },
      { en: "temperature", ru: "температура" },
      { en: "pain", ru: "боль" },
      { en: "injury", ru: "травма" },
      { en: "bruise", ru: "синяк" },
      { en: "to hurt", ru: "болеть / повредить" },
      { en: "to feel sick", ru: "чувствовать тошноту" },
      { en: "to catch a cold", ru: "простудиться" },
      { en: "to recover", ru: "выздоравливать" },
      { en: "to get better", ru: "поправляться" },
      { en: "painkiller", ru: "обезболивающее" },
      { en: "prescription", ru: "рецепт (на лекарство)" },
      { en: "to take medicine", ru: "принимать лекарство" },
      { en: "to make an appointment", ru: "записаться на прием" },
    ],
    "эмоции": [
      { en: "excited", ru: "взволнованный (радостно)" },
      { en: "nervous", ru: "нервный" },
      { en: "worried", ru: "обеспокоенный" },
      { en: "surprised", ru: "удивленный" },
      { en: "proud", ru: "гордый" },
      { en: "jealous", ru: "ревнивый / завистливый" },
      { en: "confident", ru: "уверенный" },
      { en: "upset", ru: "расстроенный" },
      { en: "relaxed", ru: "расслабленный" },
      { en: "lonely", ru: "одинокий" },
      { en: "embarrassed", ru: "смущенный" },
      { en: "calm", ru: "спокойный" },
      { en: "glad", ru: "радый" },
      { en: "pleased", ru: "довольный" },
      { en: "annoyed", ru: "раздраженный" },
      { en: "disappointed", ru: "разочарованный" },
      { en: "friendly", ru: "дружелюбный" },
      { en: "shy", ru: "застенчивый" },
      { en: "honest", ru: "честный" },
      { en: "lazy", ru: "ленивый" },
      { en: "hard-working", ru: "трудолюбивый" },
      { en: "polite", ru: "вежливый" },
      { en: "rude", ru: "грубый" },
      { en: "selfish", ru: "эгоистичный" },
      { en: "generous", ru: "щедрый" },
      { en: "patient", ru: "терпеливый" },
      { en: "cheerful", ru: "жизнерадостный" },
      { en: "serious", ru: "серьезный" },
      { en: "brave", ru: "смелый" },
      { en: "helpful", ru: "отзывчивый" },
      { en: "talkative", ru: "разговорчивый" },
      { en: "to feel", ru: "чувствовать" },
      { en: "to cheer up", ru: "подбадривать / веселеть" },
      { en: "to calm down", ru: "успокаиваться" },
      { en: "to get on well", ru: "хорошо ладить" },
      { en: "to be in a good mood", ru: "быть в хорошем настроении" },
      { en: "to be in a bad mood", ru: "быть в плохом настроении" },
      { en: "to lose one's temper", ru: "выйти из себя" },
      { en: "to be fed up", ru: "быть сытым по горло" },
      { en: "to feel like", ru: "хотеть (что-то сделать)" },
    ],
    "праздники": [
      { en: "festival", ru: "фестиваль / праздник" },
      { en: "celebration", ru: "празднование" },
      { en: "to celebrate", ru: "праздновать" },
      { en: "birthday", ru: "день рождения" },
      { en: "anniversary", ru: "годовщина" },
      { en: "wedding", ru: "свадьба" },
      { en: "guest", ru: "гость" },
      { en: "to invite", ru: "приглашать" },
      { en: "invitation", ru: "приглашение" },
      { en: "present", ru: "подарок" },
      { en: "gift", ru: "подарок" },
      { en: "to give a present", ru: "дарить подарок" },
      { en: "greeting card", ru: "поздравительная открытка" },
      { en: "candle", ru: "свеча" },
      { en: "balloon", ru: "воздушный шарик" },
      { en: "decoration", ru: "украшение" },
      { en: "to decorate", ru: "украшать" },
      { en: "fireworks", ru: "фейерверк" },
      { en: "party", ru: "вечеринка" },
      { en: "to throw a party", ru: "устроить вечеринку" },
      { en: "cake", ru: "торт" },
      { en: "to blow out candles", ru: "задувать свечи" },
      { en: "to make a wish", ru: "загадать желание" },
      { en: "tradition", ru: "традиция" },
      { en: "custom", ru: "обычай" },
      { en: "New Year", ru: "Новый год" },
      { en: "Christmas", ru: "Рождество" },
      { en: "Easter", ru: "Пасха" },
      { en: "Halloween", ru: "Хэллоуин" },
      { en: "to exchange gifts", ru: "обмениваться подарками" },
      { en: "to dress up", ru: "наряжаться" },
      { en: "costume", ru: "костюм" },
      { en: "to gather", ru: "собираться (вместе)" },
      { en: "feast", ru: "застолье" },
      { en: "to toast", ru: "произносить тост" },
      { en: "Happy birthday!", ru: "С днем рождения!" },
      { en: "Congratulations!", ru: "Поздравляю!" },
      { en: "Best wishes!", ru: "Всего наилучшего!" },
      { en: "public holiday", ru: "государственный праздник" },
      { en: "to have a day off", ru: "иметь выходной" },
    ],
    "спорт": [
      { en: "sport", ru: "спорт" },
      { en: "football", ru: "футбол" },
      { en: "basketball", ru: "баскетбол" },
      { en: "volleyball", ru: "волейбол" },
      { en: "tennis", ru: "теннис" },
      { en: "swimming", ru: "плавание" },
      { en: "athletics", ru: "легкая атлетика" },
      { en: "cycling", ru: "велоспорт" },
      { en: "skiing", ru: "катание на лыжах" },
      { en: "skating", ru: "катание на коньках" },
      { en: "boxing", ru: "бокс" },
      { en: "gym", ru: "спортзал" },
      { en: "team", ru: "команда" },
      { en: "player", ru: "игрок" },
      { en: "coach", ru: "тренер" },
      { en: "referee", ru: "судья" },
      { en: "opponent", ru: "соперник" },
      { en: "match", ru: "матч" },
      { en: "competition", ru: "соревнование" },
      { en: "championship", ru: "чемпионат" },
      { en: "tournament", ru: "турнир" },
      { en: "score", ru: "счет" },
      { en: "goal", ru: "гол" },
      { en: "winner", ru: "победитель" },
      { en: "to win", ru: "побеждать" },
      { en: "to lose", ru: "проигрывать" },
      { en: "to draw", ru: "сыграть вничью" },
      { en: "to train", ru: "тренироваться" },
      { en: "to practise", ru: "практиковаться" },
      { en: "to work out", ru: "заниматься спортом" },
      { en: "to keep fit", ru: "поддерживать форму" },
      { en: "to score a goal", ru: "забить гол" },
      { en: "to beat", ru: "обыграть" },
      { en: "pitch", ru: "поле (футбольное)" },
      { en: "court", ru: "корт / площадка" },
      { en: "stadium", ru: "стадион" },
      { en: "fan", ru: "болельщик" },
      { en: "to support a team", ru: "болеть за команду" },
      { en: "medal", ru: "медаль" },
      { en: "to take part in", ru: "участвовать в" },
    ],
    "искусство": [
      { en: "art", ru: "искусство" },
      { en: "painting", ru: "картина / живопись" },
      { en: "drawing", ru: "рисунок" },
      { en: "artist", ru: "художник" },
      { en: "painter", ru: "живописец" },
      { en: "gallery", ru: "галерея" },
      { en: "exhibition", ru: "выставка" },
      { en: "sculpture", ru: "скульптура" },
      { en: "portrait", ru: "портрет" },
      { en: "landscape", ru: "пейзаж" },
      { en: "style", ru: "стиль" },
      { en: "brush", ru: "кисть" },
      { en: "canvas", ru: "холст" },
      { en: "to sketch", ru: "делать набросок" },
      { en: "singer", ru: "певец" },
      { en: "band", ru: "группа (музыкальная)" },
      { en: "musician", ru: "музыкант" },
      { en: "composer", ru: "композитор" },
      { en: "concert", ru: "концерт" },
      { en: "orchestra", ru: "оркестр" },
      { en: "choir", ru: "хор" },
      { en: "instrument", ru: "инструмент" },
      { en: "drums", ru: "барабаны" },
      { en: "violin", ru: "скрипка" },
      { en: "trumpet", ru: "труба" },
      { en: "to perform", ru: "выступать" },
      { en: "performance", ru: "выступление" },
      { en: "voice", ru: "голос" },
      { en: "lyrics", ru: "слова песни" },
      { en: "melody", ru: "мелодия" },
      { en: "rhythm", ru: "ритм" },
      { en: "album", ru: "альбом" },
      { en: "track", ru: "трек" },
      { en: "tune", ru: "мотив / мелодия" },
      { en: "live music", ru: "живая музыка" },
      { en: "audience", ru: "публика / зрители" },
      { en: "stage", ru: "сцена" },
      { en: "talented", ru: "талантливый" },
      { en: "to be into", ru: "увлекаться" },
      { en: "masterpiece", ru: "шедевр" },
    ],
    "технологии": [
      { en: "computer", ru: "компьютер" },
      { en: "laptop", ru: "ноутбук" },
      { en: "smartphone", ru: "смартфон" },
      { en: "tablet", ru: "планшет" },
      { en: "screen", ru: "экран" },
      { en: "keyboard", ru: "клавиатура" },
      { en: "mouse", ru: "мышь" },
      { en: "charger", ru: "зарядное устройство" },
      { en: "cable", ru: "кабель / провод" },
      { en: "battery", ru: "батарея / аккумулятор" },
      { en: "headphones", ru: "наушники" },
      { en: "earphones", ru: "вкладыши-наушники" },
      { en: "speaker", ru: "колонка / динамик" },
      { en: "remote control", ru: "пульт" },
      { en: "printer", ru: "принтер" },
      { en: "plug", ru: "вилка (штепсель)" },
      { en: "socket", ru: "розетка" },
      { en: "button", ru: "кнопка" },
      { en: "device", ru: "устройство" },
      { en: "gadget", ru: "гаджет" },
      { en: "app", ru: "приложение" },
      { en: "message", ru: "сообщение" },
      { en: "file", ru: "файл" },
      { en: "folder", ru: "папка" },
      { en: "password", ru: "пароль" },
      { en: "to switch on", ru: "включать" },
      { en: "to switch off", ru: "выключать" },
      { en: "to turn up", ru: "делать громче" },
      { en: "to turn down", ru: "делать тише" },
      { en: "to charge", ru: "заряжать" },
      { en: "to plug in", ru: "подключать к сети" },
      { en: "to unplug", ru: "отключать от сети" },
      { en: "to press", ru: "нажимать" },
      { en: "to connect", ru: "подключать" },
      { en: "to install", ru: "устанавливать" },
      { en: "to update", ru: "обновлять" },
      { en: "to back up", ru: "делать резервную копию" },
      { en: "to delete", ru: "удалять" },
      { en: "to type", ru: "печатать (набирать)" },
      { en: "to download", ru: "скачивать" },
    ],
    "покупки": [
      { en: "customer", ru: "покупатель" },
      { en: "cashier", ru: "кассир" },
      { en: "receipt", ru: "чек" },
      { en: "change", ru: "сдача" },
      { en: "discount", ru: "скидка" },
      { en: "sale", ru: "распродажа" },
      { en: "special offer", ru: "спецпредложение" },
      { en: "half price", ru: "за полцены" },
      { en: "refund", ru: "возврат денег" },
      { en: "to try on", ru: "примерять" },
      { en: "to fit", ru: "подходить (по размеру)" },
      { en: "to afford", ru: "позволить себе" },
      { en: "to spend", ru: "тратить" },
      { en: "to save", ru: "копить / экономить" },
      { en: "to cost", ru: "стоить" },
      { en: "to pay for", ru: "платить за" },
      { en: "in cash", ru: "наличными" },
      { en: "by card", ru: "картой" },
      { en: "price tag", ru: "ценник" },
      { en: "shopping list", ru: "список покупок" },
      { en: "in stock", ru: "в наличии" },
      { en: "out of stock", ru: "нет в наличии" },
      { en: "bargain", ru: "выгодная покупка" },
      { en: "to queue", ru: "стоять в очереди" },
      { en: "bill", ru: "счет" },
      { en: "to lend", ru: "одолжить (кому-то)" },
      { en: "to borrow", ru: "взять в долг" },
      { en: "to owe", ru: "быть должным" },
      { en: "income", ru: "доход" },
      { en: "to waste money", ru: "тратить деньги впустую" },
      { en: "wallet", ru: "кошелек" },
      { en: "purse", ru: "женский кошелек" },
      { en: "coin", ru: "монета" },
      { en: "banknote", ru: "банкнота" },
      { en: "to withdraw", ru: "снимать (деньги)" },
      { en: "cash machine", ru: "банкомат" },
      { en: "shopping centre", ru: "торговый центр" },
      { en: "to return a product", ru: "вернуть товар" },
      { en: "to do the shopping", ru: "делать покупки" },
      { en: "value for money", ru: "хорошее соотношение цены и качества" },
    ],
    "работа": [
      { en: "employee", ru: "сотрудник" },
      { en: "employer", ru: "работодатель" },
      { en: "interview", ru: "собеседование" },
      { en: "to apply for", ru: "подавать заявку на" },
      { en: "application", ru: "заявка / заявление" },
      { en: "CV", ru: "резюме" },
      { en: "experience", ru: "опыт" },
      { en: "skills", ru: "навыки" },
      { en: "qualification", ru: "квалификация" },
      { en: "task", ru: "задача" },
      { en: "project", ru: "проект" },
      { en: "deadline", ru: "срок" },
      { en: "to hire", ru: "нанимать" },
      { en: "to employ", ru: "принимать на работу" },
      { en: "to earn", ru: "зарабатывать" },
      { en: "wages", ru: "заработок / зарплата (почасовая)" },
      { en: "full-time", ru: "полный рабочий день" },
      { en: "part-time", ru: "неполный рабочий день" },
      { en: "shift", ru: "смена" },
      { en: "to work overtime", ru: "работать сверхурочно" },
      { en: "to be fired", ru: "быть уволенным" },
      { en: "to be unemployed", ru: "быть безработным" },
      { en: "to look for a job", ru: "искать работу" },
      { en: "staff", ru: "персонал" },
      { en: "uniform", ru: "униформа" },
      { en: "accountant", ru: "бухгалтер" },
      { en: "lawyer", ru: "юрист" },
      { en: "dentist", ru: "стоматолог" },
      { en: "electrician", ru: "электрик" },
      { en: "plumber", ru: "сантехник" },
      { en: "mechanic", ru: "механик" },
      { en: "hairdresser", ru: "парикмахер" },
      { en: "chef", ru: "повар" },
      { en: "shop assistant", ru: "продавец" },
      { en: "receptionist", ru: "администратор" },
      { en: "to retire", ru: "выходить на пенсию" },
      { en: "to get a job", ru: "устроиться на работу" },
      { en: "to lose a job", ru: "потерять работу" },
      { en: "colleague", ru: "коллега" },
      { en: "to be good at", ru: "хорошо уметь" },
    ],
    "город": [
      { en: "corner", ru: "угол" },
      { en: "crossroads", ru: "перекресток" },
      { en: "roundabout", ru: "круговое движение" },
      { en: "traffic lights", ru: "светофор" },
      { en: "pedestrian crossing", ru: "пешеходный переход" },
      { en: "pavement", ru: "тротуар" },
      { en: "zebra crossing", ru: "зебра (переход)" },
      { en: "bridge", ru: "мост" },
      { en: "underground station", ru: "станция метро" },
      { en: "bus stop", ru: "автобусная остановка" },
      { en: "car park", ru: "парковка" },
      { en: "chemist", ru: "аптека" },
      { en: "department store", ru: "универмаг" },
      { en: "post office", ru: "почта" },
      { en: "petrol station", ru: "заправка" },
      { en: "to turn left", ru: "повернуть налево" },
      { en: "to turn right", ru: "повернуть направо" },
      { en: "to go straight on", ru: "идти прямо" },
      { en: "to go past", ru: "пройти мимо" },
      { en: "to cross the road", ru: "переходить дорогу" },
      { en: "to take the first turning", ru: "повернуть на первом повороте" },
      { en: "opposite", ru: "напротив" },
      { en: "next to", ru: "рядом с" },
      { en: "between", ru: "между" },
      { en: "behind", ru: "позади" },
      { en: "in front of", ru: "перед" },
      { en: "on the corner of", ru: "на углу" },
      { en: "around the corner", ru: "за углом" },
      { en: "at the end of", ru: "в конце" },
      { en: "nearby", ru: "поблизости" },
      { en: "far from", ru: "далеко от" },
      { en: "How do I get to...?", ru: "Как пройти к...?" },
      { en: "Is it far?", ru: "Это далеко?" },
      { en: "to get lost", ru: "заблудиться" },
      { en: "directions", ru: "указания пути" },
      { en: "on the left", ru: "слева" },
      { en: "on the right", ru: "справа" },
      { en: "It's a five-minute walk", ru: "Это в пяти минутах ходьбы" },
      { en: "Go along this street", ru: "Идите по этой улице" },
      { en: "straight ahead", ru: "прямо впереди" },
    ],
    "маркетинг": [
      { en: "audience", ru: "аудитория" },
      { en: "target group", ru: "целевая группа" },
      { en: "campaign", ru: "кампания" },
      { en: "launch a product", ru: "выпустить продукт на рынок" },
      { en: "budget", ru: "бюджет" },
      { en: "cost", ru: "стоимость, затраты" },
      { en: "profit", ru: "прибыль" },
      { en: "demand", ru: "спрос" },
      { en: "supply", ru: "предложение на рынке" },
      { en: "competitor", ru: "конкурент" },
      { en: "compare", ru: "сравнивать" },
      { en: "research", ru: "исследование" },
      { en: "survey", ru: "опрос" },
      { en: "result", ru: "результат" },
      { en: "increase", ru: "рост, расти" },
      { en: "decrease", ru: "снижение, снижаться" },
      { en: "grow", ru: "расти" },
      { en: "feedback", ru: "обратная связь" },
      { en: "review", ru: "отзыв" },
      { en: "customer service", ru: "обслуживание клиентов" },
      { en: "loyal customer", ru: "постоянный клиент" },
      { en: "value for money", ru: "соотношение цены и качества" },
      { en: "special offer", ru: "спецпредложение" },
      { en: "content", ru: "контент" },
      { en: "banner", ru: "баннер" },
      { en: "newsletter", ru: "рассылка" },
      { en: "subscriber", ru: "подписчик" },
      { en: "follower", ru: "подписчик в соцсетях" },
      { en: "influencer", ru: "блогер, инфлюенсер" },
      { en: "share", ru: "делиться, репостить" },
      { en: "comment", ru: "комментарий, комментировать" },
      { en: "order", ru: "заказ" },
      { en: "delivery", ru: "доставка" },
      { en: "supplier", ru: "поставщик" },
      { en: "presentation", ru: "презентация" },
      { en: "deadline", ru: "срок сдачи" },
      { en: "word of mouth", ru: "сарафанное радио" },
    ],
  },
};

// --- Уровень A1 (900+ слов, объединено из A1_* и вспомогательных списков) ---
const SEED_SHARED_LIBRARY_A1 = {
  difficulty: "A1",
  topics: {
    "семья": [
      { en: "mother", ru: "мама / мать" },
      { en: "father", ru: "папа / отец" },
      { en: "parent", ru: "родитель" },
      { en: "parents", ru: "родители" },
      { en: "son", ru: "сын" },
      { en: "daughter", ru: "дочь" },
      { en: "brother", ru: "брат" },
      { en: "sister", ru: "сестра" },
      { en: "husband", ru: "муж" },
      { en: "wife", ru: "жена" },
      { en: "child", ru: "ребёнок" },
      { en: "children", ru: "дети" },
      { en: "baby", ru: "малыш" },
      { en: "kid", ru: "ребёнок (разг.)" },
      { en: "twins", ru: "близнецы" },
      { en: "grandmother", ru: "бабушка" },
      { en: "grandfather", ru: "дедушка" },
      { en: "grandparents", ru: "бабушка и дедушка" },
      { en: "grandson", ru: "внук" },
      { en: "granddaughter", ru: "внучка" },
      { en: "grandchild", ru: "внук / внучка" },
      { en: "uncle", ru: "дядя" },
      { en: "aunt", ru: "тётя" },
      { en: "cousin", ru: "двоюродный брат / сестра" },
      { en: "nephew", ru: "племянник" },
      { en: "niece", ru: "племянница" },
      { en: "relative", ru: "родственник" },
      { en: "family", ru: "семья" },
      { en: "mother-in-law", ru: "свекровь / тёща" },
      { en: "father-in-law", ru: "свёкор / тесть" },
      { en: "brother-in-law", ru: "деверь / шурин" },
      { en: "sister-in-law", ru: "золовка / невестка" },
      { en: "stepmother", ru: "мачеха" },
      { en: "stepfather", ru: "отчим" },
      { en: "stepbrother", ru: "сводный брат" },
      { en: "stepsister", ru: "сводная сестра" },
      { en: "half-brother", ru: "сводный брат (по одному родителю)" },
      { en: "half-sister", ru: "сводная сестра (по одному родителю)" },
      { en: "friend", ru: "друг" },
      { en: "best friend", ru: "лучший друг" },
      { en: "boyfriend", ru: "парень" },
      { en: "girlfriend", ru: "девушка" },
      { en: "partner", ru: "партнёр" },
      { en: "neighbour", ru: "сосед" },
      { en: "classmate", ru: "одноклассник" },
      { en: "colleague", ru: "коллега" },
      { en: "married", ru: "женат / замужем" },
      { en: "single", ru: "холост / не замужем" },
      { en: "divorced", ru: "в разводе" },
      { en: "engaged", ru: "обручён" },
      { en: "widow", ru: "вдова" },
      { en: "widower", ru: "вдовец" },
      { en: "kind", ru: "добрый" },
      { en: "friendly", ru: "дружелюбный" },
      { en: "shy", ru: "стеснительный" },
      { en: "generous", ru: "щедрый" },
      { en: "lazy", ru: "ленивый" },
      { en: "hardworking", ru: "трудолюбивый" },
      { en: "talkative", ru: "болтливый" },
      { en: "quiet", ru: "тихий" },
      { en: "funny", ru: "смешной" },
      { en: "serious", ru: "серьёзный" },
      { en: "honest", ru: "честный" },
      { en: "polite", ru: "вежливый" },
      { en: "patient", ru: "терпеливый" },
      { en: "helpful", ru: "отзывчивый" },
      { en: "clever", ru: "умный" },
      { en: "smart", ru: "умный (амер.)" },
      { en: "strict", ru: "строгий" },
      { en: "calm", ru: "спокойный" },
      { en: "nice", ru: "приятный" },
      { en: "rude", ru: "грубый" },
      { en: "tall", ru: "высокий" },
      { en: "short", ru: "низкий / невысокий" },
      { en: "slim", ru: "стройный" },
      { en: "plump", ru: "полный" },
      { en: "beautiful", ru: "красивая" },
      { en: "handsome", ru: "красивый (о мужчине)" },
      { en: "pretty", ru: "симпатичная" },
      { en: "cute", ru: "милый" },
      { en: "young", ru: "молодой" },
      { en: "old", ru: "старый" },
      { en: "middle-aged", ru: "среднего возраста" },
      { en: "hair", ru: "волосы" },
      { en: "eyes", ru: "глаза" },
      { en: "beard", ru: "борода" },
      { en: "moustache", ru: "усы" },
      { en: "glasses", ru: "очки" },
      { en: "curly hair", ru: "кудрявые волосы" },
      { en: "straight hair", ru: "прямые волосы" },
      { en: "long hair", ru: "длинные волосы" },
      { en: "short hair", ru: "короткие волосы" },
      { en: "blonde", ru: "светловолосый" },
      { en: "brunette", ru: "брюнет" },
      { en: "red-haired", ru: "рыжий" },
      { en: "blue eyes", ru: "голубые глаза" },
      { en: "green eyes", ru: "зелёные глаза" },
      { en: "brown eyes", ru: "карие глаза" },
      { en: "dark eyes", ru: "тёмные глаза" },
    ],
    "работа": [
      { en: "teacher", ru: "учитель" },
      { en: "doctor", ru: "врач" },
      { en: "nurse", ru: "медсестра" },
      { en: "engineer", ru: "инженер" },
      { en: "manager", ru: "менеджер" },
      { en: "designer", ru: "дизайнер" },
      { en: "programmer", ru: "программист" },
      { en: "developer", ru: "разработчик" },
      { en: "lawyer", ru: "юрист" },
      { en: "journalist", ru: "журналист" },
      { en: "accountant", ru: "бухгалтер" },
      { en: "chef", ru: "шеф-повар" },
      { en: "cook", ru: "повар" },
      { en: "driver", ru: "водитель" },
      { en: "waiter", ru: "официант" },
      { en: "waitress", ru: "официантка" },
      { en: "salesperson", ru: "продавец" },
      { en: "shop assistant", ru: "продавец-консультант" },
      { en: "electrician", ru: "электрик" },
      { en: "plumber", ru: "сантехник" },
      { en: "mechanic", ru: "механик" },
      { en: "builder", ru: "строитель" },
      { en: "architect", ru: "архитектор" },
      { en: "artist", ru: "художник" },
      { en: "musician", ru: "музыкант" },
      { en: "actor", ru: "актёр" },
      { en: "actress", ru: "актриса" },
      { en: "singer", ru: "певец" },
      { en: "writer", ru: "писатель" },
      { en: "photographer", ru: "фотограф" },
      { en: "dentist", ru: "стоматолог" },
      { en: "vet", ru: "ветеринар" },
      { en: "police officer", ru: "полицейский" },
      { en: "firefighter", ru: "пожарный" },
      { en: "soldier", ru: "солдат" },
      { en: "pilot", ru: "пилот" },
      { en: "flight attendant", ru: "бортпроводник" },
      { en: "farmer", ru: "фермер" },
      { en: "hairdresser", ru: "парикмахер" },
      { en: "cleaner", ru: "уборщик" },
      { en: "secretary", ru: "секретарь" },
      { en: "banker", ru: "банкир" },
      { en: "businessman", ru: "бизнесмен" },
      { en: "businesswoman", ru: "бизнес-леди" },
      { en: "student", ru: "студент" },
      { en: "scientist", ru: "учёный" },
      { en: "researcher", ru: "исследователь" },
      { en: "translator", ru: "переводчик" },
      { en: "office", ru: "офис" },
      { en: "desk", ru: "рабочий стол" },
      { en: "chair", ru: "стул" },
      { en: "computer", ru: "компьютер" },
      { en: "laptop", ru: "ноутбук" },
      { en: "printer", ru: "принтер" },
      { en: "phone", ru: "телефон" },
      { en: "email", ru: "электронная почта" },
      { en: "meeting", ru: "встреча" },
      { en: "boss", ru: "начальник" },
      { en: "team", ru: "команда" },
      { en: "salary", ru: "зарплата" },
      { en: "contract", ru: "контракт" },
      { en: "deadline", ru: "срок / дедлайн" },
      { en: "project", ru: "проект" },
      { en: "client", ru: "клиент" },
      { en: "customer", ru: "покупатель / клиент" },
      { en: "job", ru: "работа" },
      { en: "career", ru: "карьера" },
      { en: "company", ru: "компания" },
      { en: "business", ru: "бизнес" },
      { en: "office hours", ru: "рабочее время" },
      { en: "break", ru: "перерыв" },
      { en: "lunch break", ru: "обеденный перерыв" },
      { en: "work", ru: "работать" },
      { en: "earn", ru: "зарабатывать" },
      { en: "hire", ru: "нанимать" },
      { en: "fire", ru: "увольнять" },
      { en: "apply", ru: "подавать заявку" },
      { en: "sign", ru: "подписывать" },
      { en: "attend", ru: "посещать" },
      { en: "present", ru: "представлять" },
      { en: "manage", ru: "управлять" },
      { en: "report", ru: "отчитываться" },
      { en: "quit", ru: "уволиться" },
      { en: "retire", ru: "выйти на пенсию" },
      { en: "get a job", ru: "устроиться на работу" },
      { en: "get promoted", ru: "получить повышение" },
      { en: "look for a job", ru: "искать работу" },
      { en: "work from home", ru: "работать из дома" },
      { en: "busy", ru: "занятой" },
      { en: "free", ru: "свободный" },
      { en: "stressed", ru: "на нервах" },
      { en: "tired", ru: "уставший" },
      { en: "unemployed", ru: "безработный" },
      { en: "employed", ru: "трудоустроенный" },
      { en: "full-time", ru: "полный рабочий день" },
      { en: "part-time", ru: "частичная занятость" },
      { en: "freelance", ru: "фриланс" },
      { en: "remote", ru: "удалённый" },
    ],
    "дом": [
      { en: "house", ru: "дом" },
      { en: "flat", ru: "квартира" },
      { en: "apartment", ru: "квартира (амер.)" },
      { en: "cottage", ru: "коттедж" },
      { en: "villa", ru: "вилла" },
      { en: "studio", ru: "студия" },
      { en: "room", ru: "комната" },
      { en: "building", ru: "здание" },
      { en: "floor", ru: "этаж" },
      { en: "ground floor", ru: "первый этаж" },
      { en: "balcony", ru: "балкон" },
      { en: "garden", ru: "сад" },
      { en: "yard", ru: "двор" },
      { en: "garage", ru: "гараж" },
      { en: "entrance", ru: "вход" },
      { en: "lift", ru: "лифт" },
      { en: "elevator", ru: "лифт (амер.)" },
      { en: "stairs", ru: "лестница" },
      { en: "kitchen", ru: "кухня" },
      { en: "bathroom", ru: "ванная" },
      { en: "bedroom", ru: "спальня" },
      { en: "living room", ru: "гостиная" },
      { en: "dining room", ru: "столовая" },
      { en: "study", ru: "кабинет" },
      { en: "basement", ru: "подвал" },
      { en: "attic", ru: "чердак" },
      { en: "hallway", ru: "прихожая" },
      { en: "toilet", ru: "туалет" },
      { en: "sofa", ru: "диван" },
      { en: "armchair", ru: "кресло" },
      { en: "chair", ru: "стул" },
      { en: "table", ru: "стол" },
      { en: "desk", ru: "рабочий стол" },
      { en: "bed", ru: "кровать" },
      { en: "wardrobe", ru: "шкаф (для одежды)" },
      { en: "bookshelf", ru: "книжная полка" },
      { en: "shelf", ru: "полка" },
      { en: "cupboard", ru: "буфет / шкафчик" },
      { en: "drawer", ru: "ящик" },
      { en: "mirror", ru: "зеркало" },
      { en: "lamp", ru: "лампа" },
      { en: "carpet", ru: "ковёр" },
      { en: "rug", ru: "коврик" },
      { en: "curtains", ru: "шторы" },
      { en: "pillow", ru: "подушка" },
      { en: "blanket", ru: "одеяло" },
      { en: "sheet", ru: "простыня" },
      { en: "fridge", ru: "холодильник" },
      { en: "oven", ru: "духовка" },
      { en: "stove", ru: "плита" },
      { en: "dishwasher", ru: "посудомойка" },
      { en: "washing machine", ru: "стиральная машина" },
      { en: "microwave", ru: "микроволновка" },
      { en: "kettle", ru: "чайник" },
      { en: "toaster", ru: "тостер" },
      { en: "TV", ru: "телевизор" },
      { en: "remote control", ru: "пульт" },
      { en: "vacuum cleaner", ru: "пылесос" },
      { en: "iron", ru: "утюг" },
      { en: "hairdryer", ru: "фен" },
      { en: "sink", ru: "раковина" },
      { en: "bath", ru: "ванна" },
      { en: "shower", ru: "душ" },
      { en: "toothbrush", ru: "зубная щётка" },
      { en: "toothpaste", ru: "зубная паста" },
      { en: "soap", ru: "мыло" },
      { en: "towel", ru: "полотенце" },
      { en: "shampoo", ru: "шампунь" },
      { en: "door", ru: "дверь" },
      { en: "window", ru: "окно" },
      { en: "wall", ru: "стена" },
      { en: "ceiling", ru: "потолок" },
      { en: "roof", ru: "крыша" },
      { en: "key", ru: "ключ" },
      { en: "lock", ru: "замок" },
      { en: "clock", ru: "часы" },
      { en: "picture", ru: "картина" },
      { en: "plant", ru: "растение" },
      { en: "flowers", ru: "цветы" },
      { en: "candle", ru: "свеча" },
      { en: "photo", ru: "фотография" },
      { en: "cook", ru: "готовить" },
      { en: "clean", ru: "убирать" },
      { en: "wash", ru: "мыть" },
      { en: "tidy", ru: "наводить порядок" },
      { en: "repair", ru: "чинить" },
      { en: "fix", ru: "починить" },
      { en: "sleep", ru: "спать" },
      { en: "relax", ru: "отдыхать" },
      { en: "live", ru: "жить" },
      { en: "move", ru: "переезжать" },
      { en: "rent", ru: "снимать" },
      { en: "buy", ru: "покупать" },
      { en: "sell", ru: "продавать" },
      { en: "own", ru: "владеть" },
      { en: "share", ru: "делить" },
    ],
    "еда": [
      { en: "bread", ru: "хлеб" },
      { en: "toast", ru: "тост" },
      { en: "rice", ru: "рис" },
      { en: "pasta", ru: "макароны" },
      { en: "noodles", ru: "лапша" },
      { en: "cereal", ru: "хлопья" },
      { en: "flour", ru: "мука" },
      { en: "milk", ru: "молоко" },
      { en: "cheese", ru: "сыр" },
      { en: "butter", ru: "масло (сливочное)" },
      { en: "yogurt", ru: "йогурт" },
      { en: "cream", ru: "сливки" },
      { en: "meat", ru: "мясо" },
      { en: "beef", ru: "говядина" },
      { en: "pork", ru: "свинина" },
      { en: "chicken", ru: "курица" },
      { en: "turkey", ru: "индейка" },
      { en: "lamb", ru: "баранина" },
      { en: "fish", ru: "рыба" },
      { en: "salmon", ru: "лосось" },
      { en: "tuna", ru: "тунец" },
      { en: "shrimp", ru: "креветки" },
      { en: "egg", ru: "яйцо" },
      { en: "eggs", ru: "яйца" },
      { en: "vegetable", ru: "овощ" },
      { en: "vegetables", ru: "овощи" },
      { en: "potato", ru: "картошка" },
      { en: "tomato", ru: "помидор" },
      { en: "cucumber", ru: "огурец" },
      { en: "onion", ru: "лук" },
      { en: "garlic", ru: "чеснок" },
      { en: "carrot", ru: "морковь" },
      { en: "cabbage", ru: "капуста" },
      { en: "pepper", ru: "перец (овощ)" },
      { en: "salad", ru: "салат" },
      { en: "mushroom", ru: "гриб" },
      { en: "broccoli", ru: "брокколи" },
      { en: "fruit", ru: "фрукт" },
      { en: "fruits", ru: "фрукты" },
      { en: "apple", ru: "яблоко" },
      { en: "banana", ru: "банан" },
      { en: "orange", ru: "апельсин" },
      { en: "lemon", ru: "лимон" },
      { en: "strawberry", ru: "клубника" },
      { en: "grapes", ru: "виноград" },
      { en: "watermelon", ru: "арбуз" },
      { en: "pineapple", ru: "ананас" },
      { en: "peach", ru: "персик" },
      { en: "pear", ru: "груша" },
      { en: "sugar", ru: "сахар" },
      { en: "salt", ru: "соль" },
      { en: "chocolate", ru: "шоколад" },
      { en: "cake", ru: "торт" },
      { en: "cookie", ru: "печенье" },
      { en: "ice cream", ru: "мороженое" },
      { en: "jam", ru: "джем" },
      { en: "honey", ru: "мёд" },
      { en: "oil", ru: "масло (растительное)" },
      { en: "olive oil", ru: "оливковое масло" },
      { en: "vinegar", ru: "уксус" },
      { en: "sauce", ru: "соус" },
      { en: "ketchup", ru: "кетчуп" },
      { en: "mayonnaise", ru: "майонез" },
      { en: "water", ru: "вода" },
      { en: "coffee", ru: "кофе" },
      { en: "tea", ru: "чай" },
      { en: "juice", ru: "сок" },
      { en: "wine", ru: "вино" },
      { en: "beer", ru: "пиво" },
      { en: "cocktail", ru: "коктейль" },
      { en: "champagne", ru: "шампанское" },
      { en: "sparkling water", ru: "газированная вода" },
      { en: "still water", ru: "негазированная вода" },
      { en: "breakfast", ru: "завтрак" },
      { en: "lunch", ru: "обед" },
      { en: "dinner", ru: "ужин" },
      { en: "brunch", ru: "поздний завтрак" },
      { en: "snack", ru: "перекус" },
      { en: "dessert", ru: "десерт" },
      { en: "appetiser", ru: "закуска" },
      { en: "main course", ru: "основное блюдо" },
      { en: "cook", ru: "готовить" },
      { en: "boil", ru: "варить" },
      { en: "fry", ru: "жарить" },
      { en: "bake", ru: "печь" },
      { en: "grill", ru: "жарить на гриле" },
      { en: "cut", ru: "резать" },
      { en: "mix", ru: "смешивать" },
      { en: "add", ru: "добавлять" },
      { en: "serve", ru: "подавать" },
      { en: "order", ru: "заказывать" },
      { en: "taste", ru: "пробовать" },
      { en: "sweet", ru: "сладкий" },
      { en: "salty", ru: "солёный" },
      { en: "spicy", ru: "острый" },
      { en: "sour", ru: "кислый" },
      { en: "bitter", ru: "горький" },
      { en: "fresh", ru: "свежий" },
      { en: "delicious", ru: "вкусный" },
      { en: "hot", ru: "горячий" },
      { en: "cold", ru: "холодный" },
      { en: "plate", ru: "тарелка" },
      { en: "fork", ru: "вилка" },
      { en: "knife", ru: "нож" },
      { en: "spoon", ru: "ложка" },
      { en: "glass", ru: "стакан" },
      { en: "cup", ru: "чашка" },
      { en: "mug", ru: "кружка" },
      { en: "bottle", ru: "бутылка" },
      { en: "bowl", ru: "миска" },
      { en: "napkin", ru: "салфетка" },
    ],
    "время": [
      { en: "time", ru: "время" },
      { en: "morning", ru: "утро" },
      { en: "afternoon", ru: "день (после полудня)" },
      { en: "evening", ru: "вечер" },
      { en: "night", ru: "ночь" },
      { en: "midnight", ru: "полночь" },
      { en: "noon", ru: "полдень" },
      { en: "midday", ru: "полдень" },
      { en: "sunrise", ru: "рассвет" },
      { en: "sunset", ru: "закат" },
      { en: "dawn", ru: "рассвет" },
      { en: "dusk", ru: "сумерки" },
      { en: "Monday", ru: "понедельник" },
      { en: "Tuesday", ru: "вторник" },
      { en: "Wednesday", ru: "среда" },
      { en: "Thursday", ru: "четверг" },
      { en: "Friday", ru: "пятница" },
      { en: "Saturday", ru: "суббота" },
      { en: "Sunday", ru: "воскресенье" },
      { en: "weekend", ru: "выходные" },
      { en: "weekday", ru: "будний день" },
      { en: "day", ru: "день" },
      { en: "January", ru: "январь" },
      { en: "February", ru: "февраль" },
      { en: "March", ru: "март" },
      { en: "April", ru: "апрель" },
      { en: "May", ru: "май" },
      { en: "June", ru: "июнь" },
      { en: "July", ru: "июль" },
      { en: "August", ru: "август" },
      { en: "September", ru: "сентябрь" },
      { en: "October", ru: "октябрь" },
      { en: "November", ru: "ноябрь" },
      { en: "December", ru: "декабрь" },
      { en: "month", ru: "месяц" },
      { en: "season", ru: "сезон" },
      { en: "spring", ru: "весна" },
      { en: "summer", ru: "лето" },
      { en: "autumn", ru: "осень" },
      { en: "fall", ru: "осень (амер.)" },
      { en: "winter", ru: "зима" },
      { en: "year", ru: "год" },
      { en: "century", ru: "век" },
      { en: "decade", ru: "десятилетие" },
      { en: "second", ru: "секунда" },
      { en: "minute", ru: "минута" },
      { en: "hour", ru: "час" },
      { en: "half an hour", ru: "полчаса" },
      { en: "quarter of an hour", ru: "четверть часа" },
      { en: "week", ru: "неделя" },
      { en: "fortnight", ru: "две недели" },
      { en: "o'clock", ru: "часов (ровно)" },
      { en: "half past", ru: "половина" },
      { en: "quarter past", ru: "четверть после" },
      { en: "quarter to", ru: "без четверти" },
      { en: "am", ru: "утра" },
      { en: "pm", ru: "вечера" },
      { en: "always", ru: "всегда" },
      { en: "usually", ru: "обычно" },
      { en: "often", ru: "часто" },
      { en: "sometimes", ru: "иногда" },
      { en: "rarely", ru: "редко" },
      { en: "seldom", ru: "редко" },
      { en: "never", ru: "никогда" },
      { en: "every day", ru: "каждый день" },
      { en: "every week", ru: "каждую неделю" },
      { en: "every month", ru: "каждый месяц" },
      { en: "every year", ru: "каждый год" },
      { en: "once a week", ru: "раз в неделю" },
      { en: "twice a week", ru: "два раза в неделю" },
      { en: "three times a week", ru: "три раза в неделю" },
      { en: "once a month", ru: "раз в месяц" },
      { en: "once a year", ru: "раз в год" },
      { en: "today", ru: "сегодня" },
      { en: "yesterday", ru: "вчера" },
      { en: "tomorrow", ru: "завтра" },
      { en: "the day before yesterday", ru: "позавчера" },
      { en: "the day after tomorrow", ru: "послезавтра" },
      { en: "now", ru: "сейчас" },
      { en: "later", ru: "позже" },
      { en: "soon", ru: "скоро" },
      { en: "early", ru: "рано" },
      { en: "late", ru: "поздно" },
      { en: "on time", ru: "вовремя" },
      { en: "in time", ru: "к нужному моменту" },
      { en: "birthday", ru: "день рождения" },
      { en: "holiday", ru: "праздник / отпуск" },
      { en: "vacation", ru: "отпуск (амер.)" },
      { en: "anniversary", ru: "годовщина" },
      { en: "appointment", ru: "встреча (запланированная)" },
      { en: "date", ru: "свидание / дата" },
      { en: "meeting", ru: "встреча" },
      { en: "event", ru: "событие" },
      { en: "schedule", ru: "расписание" },
      { en: "timetable", ru: "расписание (поездов, занятий)" },
      { en: "calendar", ru: "календарь" },
      { en: "diary", ru: "ежедневник" },
      { en: "clock", ru: "часы (настенные)" },
      { en: "watch", ru: "часы (наручные)" },
      { en: "alarm", ru: "будильник" },
      { en: "moment", ru: "момент" },
    ],
    "страны": [
      { en: "country", ru: "страна" },
      { en: "city", ru: "город" },
      { en: "town", ru: "городок" },
      { en: "village", ru: "деревня" },
      { en: "capital", ru: "столица" },
      { en: "state", ru: "штат / государство" },
      { en: "region", ru: "регион" },
      { en: "continent", ru: "континент" },
      { en: "border", ru: "граница" },
      { en: "abroad", ru: "за границей" },
      { en: "foreign", ru: "иностранный" },
      { en: "local", ru: "местный" },
      { en: "nationality", ru: "национальность" },
      { en: "language", ru: "язык" },
      { en: "Russia", ru: "Россия" },
      { en: "the USA", ru: "США" },
      { en: "the UK", ru: "Великобритания" },
      { en: "England", ru: "Англия" },
      { en: "Scotland", ru: "Шотландия" },
      { en: "Ireland", ru: "Ирландия" },
      { en: "Wales", ru: "Уэльс" },
      { en: "Germany", ru: "Германия" },
      { en: "France", ru: "Франция" },
      { en: "Italy", ru: "Италия" },
      { en: "Spain", ru: "Испания" },
      { en: "Portugal", ru: "Португалия" },
      { en: "Poland", ru: "Польша" },
      { en: "the Netherlands", ru: "Нидерланды" },
      { en: "Belgium", ru: "Бельгия" },
      { en: "Sweden", ru: "Швеция" },
      { en: "Norway", ru: "Норвегия" },
      { en: "Finland", ru: "Финляндия" },
      { en: "Denmark", ru: "Дания" },
      { en: "Greece", ru: "Греция" },
      { en: "Turkey", ru: "Турция" },
      { en: "China", ru: "Китай" },
      { en: "Japan", ru: "Япония" },
      { en: "Korea", ru: "Корея" },
      { en: "South Korea", ru: "Южная Корея" },
      { en: "India", ru: "Индия" },
      { en: "Vietnam", ru: "Вьетнам" },
      { en: "Thailand", ru: "Таиланд" },
      { en: "Brazil", ru: "Бразилия" },
      { en: "Argentina", ru: "Аргентина" },
      { en: "Mexico", ru: "Мексика" },
      { en: "Canada", ru: "Канада" },
      { en: "Australia", ru: "Австралия" },
      { en: "New Zealand", ru: "Новая Зеландия" },
      { en: "Egypt", ru: "Египет" },
      { en: "South Africa", ru: "ЮАР" },
      { en: "Russian (person)", ru: "русский" },
      { en: "American", ru: "американец" },
      { en: "British", ru: "британец" },
      { en: "English (person)", ru: "англичанин" },
      { en: "Scottish", ru: "шотландец" },
      { en: "Irish", ru: "ирландец" },
      { en: "Welsh", ru: "валлиец" },
      { en: "German (person)", ru: "немец" },
      { en: "French (person)", ru: "француз" },
      { en: "Italian (person)", ru: "итальянец" },
      { en: "Spanish (person)", ru: "испанец" },
      { en: "Portuguese (person)", ru: "португалец" },
      { en: "Polish (person)", ru: "поляк" },
      { en: "Dutch", ru: "голландец" },
      { en: "Swedish (person)", ru: "швед" },
      { en: "Norwegian", ru: "норвежец" },
      { en: "Finnish", ru: "финн" },
      { en: "Danish", ru: "датчанин" },
      { en: "Greek", ru: "грек" },
      { en: "Turkish (person)", ru: "турок" },
      { en: "Chinese (person)", ru: "китаец" },
      { en: "Japanese (person)", ru: "японец" },
      { en: "Korean (person)", ru: "кореец" },
      { en: "Indian", ru: "индиец" },
      { en: "Vietnamese (person)", ru: "вьетнамец" },
      { en: "Thai (person)", ru: "таец" },
      { en: "Brazilian", ru: "бразилец" },
      { en: "Mexican", ru: "мексиканец" },
      { en: "Canadian", ru: "канадец" },
      { en: "Australian", ru: "австралиец" },
      { en: "Egyptian", ru: "египтянин" },
      { en: "African", ru: "африканец" },
      { en: "European", ru: "европеец" },
      { en: "Asian", ru: "азиат" },
      { en: "English (language)", ru: "английский язык" },
      { en: "Russian (language)", ru: "русский язык" },
      { en: "Spanish (language)", ru: "испанский язык" },
      { en: "French (language)", ru: "французский язык" },
      { en: "German (language)", ru: "немецкий язык" },
      { en: "Italian (language)", ru: "итальянский язык" },
      { en: "Portuguese (language)", ru: "португальский язык" },
      { en: "Chinese (language)", ru: "китайский язык" },
      { en: "Mandarin", ru: "мандаринский китайский" },
      { en: "Japanese (language)", ru: "японский язык" },
      { en: "Korean (language)", ru: "корейский язык" },
      { en: "Arabic", ru: "арабский язык" },
      { en: "Turkish (language)", ru: "турецкий язык" },
      { en: "Hindi", ru: "хинди" },
      { en: "mother tongue", ru: "родной язык" },
      { en: "native speaker", ru: "носитель языка" },
      { en: "accent", ru: "акцент" },
      { en: "fluent", ru: "свободно говорящий" },
    ],
    "хобби": [
      { en: "hobby", ru: "хобби" },
      { en: "free time", ru: "свободное время" },
      { en: "sport", ru: "спорт" },
      { en: "football", ru: "футбол" },
      { en: "soccer", ru: "футбол (амер.)" },
      { en: "basketball", ru: "баскетбол" },
      { en: "volleyball", ru: "волейбол" },
      { en: "tennis", ru: "теннис" },
      { en: "table tennis", ru: "настольный теннис" },
      { en: "badminton", ru: "бадминтон" },
      { en: "swimming", ru: "плавание" },
      { en: "running", ru: "бег" },
      { en: "jogging", ru: "пробежка" },
      { en: "cycling", ru: "велоспорт" },
      { en: "yoga", ru: "йога" },
      { en: "pilates", ru: "пилатес" },
      { en: "gym", ru: "спортзал" },
      { en: "fitness", ru: "фитнес" },
      { en: "boxing", ru: "бокс" },
      { en: "karate", ru: "каратэ" },
      { en: "golf", ru: "гольф" },
      { en: "hiking", ru: "пешие походы" },
      { en: "climbing", ru: "скалолазание" },
      { en: "skiing", ru: "лыжи" },
      { en: "snowboarding", ru: "сноуборд" },
      { en: "skateboarding", ru: "скейтбординг" },
      { en: "surfing", ru: "сёрфинг" },
      { en: "horse riding", ru: "верховая езда" },
      { en: "dancing", ru: "танцы" },
      { en: "painting", ru: "рисование (краски)" },
      { en: "drawing", ru: "рисование (карандаш)" },
      { en: "photography", ru: "фотография" },
      { en: "knitting", ru: "вязание" },
      { en: "sewing", ru: "шитьё" },
      { en: "cooking", ru: "готовка" },
      { en: "baking", ru: "выпечка" },
      { en: "writing", ru: "писательство" },
      { en: "poetry", ru: "поэзия" },
      { en: "crafts", ru: "рукоделие" },
      { en: "gardening", ru: "садоводство" },
      { en: "music", ru: "музыка" },
      { en: "guitar", ru: "гитара" },
      { en: "piano", ru: "пианино" },
      { en: "violin", ru: "скрипка" },
      { en: "drums", ru: "барабаны" },
      { en: "flute", ru: "флейта" },
      { en: "singing", ru: "пение" },
      { en: "concert", ru: "концерт" },
      { en: "band", ru: "группа" },
      { en: "song", ru: "песня" },
      { en: "album", ru: "альбом" },
      { en: "playlist", ru: "плейлист" },
      { en: "reading", ru: "чтение" },
      { en: "book", ru: "книга" },
      { en: "novel", ru: "роман" },
      { en: "magazine", ru: "журнал" },
      { en: "newspaper", ru: "газета" },
      { en: "watching films", ru: "смотреть фильмы" },
      { en: "film", ru: "фильм" },
      { en: "movie", ru: "фильм (амер.)" },
      { en: "series", ru: "сериал" },
      { en: "TV show", ru: "телешоу" },
      { en: "listening to music", ru: "слушать музыку" },
      { en: "podcast", ru: "подкаст" },
      { en: "gaming", ru: "компьютерные игры" },
      { en: "video games", ru: "видеоигры" },
      { en: "board games", ru: "настольные игры" },
      { en: "puzzles", ru: "пазлы" },
      { en: "chess", ru: "шахматы" },
      { en: "travel", ru: "путешествие" },
      { en: "trip", ru: "поездка" },
      { en: "holiday", ru: "отпуск" },
      { en: "vacation", ru: "отпуск (амер.)" },
      { en: "journey", ru: "поездка / путь" },
      { en: "visit", ru: "посещать" },
      { en: "sightseeing", ru: "осмотр достопримечательностей" },
      { en: "beach", ru: "пляж" },
      { en: "mountains", ru: "горы" },
      { en: "camping", ru: "кемпинг" },
      { en: "backpacking", ru: "поход с рюкзаком" },
      { en: "party", ru: "вечеринка" },
      { en: "cinema", ru: "кино" },
      { en: "theatre", ru: "театр" },
      { en: "museum", ru: "музей" },
      { en: "restaurant", ru: "ресторан" },
      { en: "cafe", ru: "кафе" },
      { en: "club", ru: "клуб" },
      { en: "shopping", ru: "шопинг" },
      { en: "date", ru: "свидание" },
      { en: "play", ru: "играть" },
      { en: "go", ru: "ходить / идти" },
      { en: "watch", ru: "смотреть" },
      { en: "read", ru: "читать" },
      { en: "listen", ru: "слушать" },
      { en: "collect", ru: "собирать" },
      { en: "enjoy", ru: "наслаждаться" },
      { en: "love", ru: "любить" },
      { en: "like", ru: "нравиться" },
      { en: "prefer", ru: "предпочитать" },
      { en: "hate", ru: "ненавидеть" },
      { en: "hang out", ru: "тусоваться" },
      { en: "chill", ru: "отдыхать" },
    ],
    "транспорт": [
      { en: "transport", ru: "транспорт" },
      { en: "car", ru: "машина" },
      { en: "bus", ru: "автобус" },
      { en: "train", ru: "поезд" },
      { en: "plane", ru: "самолёт" },
      { en: "ship", ru: "корабль" },
      { en: "boat", ru: "лодка" },
      { en: "ferry", ru: "паром" },
      { en: "taxi", ru: "такси" },
      { en: "bike", ru: "велосипед" },
      { en: "bicycle", ru: "велосипед" },
      { en: "motorbike", ru: "мотоцикл" },
      { en: "tram", ru: "трамвай" },
      { en: "underground", ru: "метро" },
      { en: "subway", ru: "метро (амер.)" },
      { en: "metro", ru: "метро" },
      { en: "helicopter", ru: "вертолёт" },
      { en: "truck", ru: "грузовик" },
      { en: "van", ru: "фургон" },
      { en: "scooter", ru: "скутер" },
      { en: "station", ru: "станция" },
      { en: "train station", ru: "железнодорожный вокзал" },
      { en: "bus stop", ru: "автобусная остановка" },
      { en: "airport", ru: "аэропорт" },
      { en: "port", ru: "порт" },
      { en: "platform", ru: "платформа" },
      { en: "ticket", ru: "билет" },
      { en: "ticket office", ru: "билетная касса" },
      { en: "seat", ru: "место" },
      { en: "passenger", ru: "пассажир" },
      { en: "driver", ru: "водитель" },
      { en: "luggage", ru: "багаж" },
      { en: "suitcase", ru: "чемодан" },
      { en: "go by car", ru: "ехать на машине" },
      { en: "take a bus", ru: "ехать на автобусе" },
      { en: "take a taxi", ru: "взять такси" },
      { en: "catch a train", ru: "успеть на поезд" },
      { en: "miss the train", ru: "опоздать на поезд" },
      { en: "get on", ru: "садиться (в транспорт)" },
      { en: "get off", ru: "выходить (из транспорта)" },
      { en: "drive", ru: "водить" },
      { en: "ride", ru: "кататься" },
      { en: "park", ru: "парковаться" },
      { en: "arrive", ru: "прибывать" },
      { en: "leave", ru: "отправляться" },
      { en: "depart", ru: "отправляться" },
      { en: "city", ru: "город" },
      { en: "town", ru: "городок" },
      { en: "street", ru: "улица" },
      { en: "road", ru: "дорога" },
      { en: "avenue", ru: "проспект" },
      { en: "square", ru: "площадь" },
      { en: "museum", ru: "музей" },
      { en: "theatre", ru: "театр" },
      { en: "cinema", ru: "кинотеатр" },
      { en: "library", ru: "библиотека" },
      { en: "bank", ru: "банк" },
      { en: "hospital", ru: "больница" },
      { en: "clinic", ru: "поликлиника" },
      { en: "post office", ru: "почта" },
      { en: "school", ru: "школа" },
      { en: "university", ru: "университет" },
      { en: "church", ru: "церковь" },
      { en: "shop", ru: "магазин" },
      { en: "supermarket", ru: "супермаркет" },
      { en: "market", ru: "рынок" },
      { en: "restaurant", ru: "ресторан" },
      { en: "cafe", ru: "кафе" },
      { en: "bar", ru: "бар" },
      { en: "hotel", ru: "гостиница" },
      { en: "pharmacy", ru: "аптека" },
      { en: "police station", ru: "полицейский участок" },
      { en: "fire station", ru: "пожарная часть" },
      { en: "gym", ru: "спортзал" },
      { en: "swimming pool", ru: "бассейн" },
      { en: "stadium", ru: "стадион" },
      { en: "zoo", ru: "зоопарк" },
      { en: "bridge", ru: "мост" },
      { en: "tunnel", ru: "тоннель" },
      { en: "fountain", ru: "фонтан" },
      { en: "statue", ru: "статуя" },
      { en: "monument", ru: "памятник" },
      { en: "crossing", ru: "пешеходный переход" },
      { en: "zebra crossing", ru: "зебра" },
      { en: "traffic lights", ru: "светофор" },
      { en: "roundabout", ru: "кольцевая развязка" },
      { en: "corner", ru: "угол" },
      { en: "junction", ru: "перекрёсток" },
      { en: "pavement", ru: "тротуар" },
      { en: "sidewalk", ru: "тротуар (амер.)" },
      { en: "go", ru: "идти" },
      { en: "come", ru: "приходить" },
      { en: "return", ru: "возвращаться" },
      { en: "walk", ru: "ходить пешком" },
      { en: "run", ru: "бежать" },
      { en: "travel", ru: "путешествовать" },
      { en: "stop", ru: "останавливаться" },
      { en: "cross", ru: "переходить" },
      { en: "turn", ru: "поворачивать" },
      { en: "turn left", ru: "повернуть налево" },
      { en: "turn right", ru: "повернуть направо" },
      { en: "follow", ru: "следовать" },
      { en: "get lost", ru: "заблудиться" },
      { en: "village", ru: "деревня" },
      { en: "country", ru: "страна" },
      { en: "capital", ru: "столица" },
      { en: "store", ru: "магазин (US)" },
      { en: "map", ru: "карта" },
    ],
    "природа": [
      { en: "weather", ru: "погода" },
      { en: "sunny", ru: "солнечный" },
      { en: "cloudy", ru: "облачный" },
      { en: "rainy", ru: "дождливый" },
      { en: "windy", ru: "ветреный" },
      { en: "snowy", ru: "снежный" },
      { en: "foggy", ru: "туманный" },
      { en: "stormy", ru: "штормовой" },
      { en: "hot", ru: "жаркий" },
      { en: "warm", ru: "тёплый" },
      { en: "cool", ru: "прохладный" },
      { en: "cold", ru: "холодный" },
      { en: "freezing", ru: "морозный" },
      { en: "humid", ru: "влажный" },
      { en: "dry", ru: "сухой" },
      { en: "clear", ru: "ясный" },
      { en: "mild", ru: "мягкий (о погоде)" },
      { en: "sun", ru: "солнце" },
      { en: "rain", ru: "дождь" },
      { en: "snow", ru: "снег" },
      { en: "wind", ru: "ветер" },
      { en: "cloud", ru: "облако" },
      { en: "storm", ru: "гроза / буря" },
      { en: "thunder", ru: "гром" },
      { en: "lightning", ru: "молния" },
      { en: "fog", ru: "туман" },
      { en: "mist", ru: "дымка" },
      { en: "rainbow", ru: "радуга" },
      { en: "ice", ru: "лёд" },
      { en: "hail", ru: "град" },
      { en: "shower", ru: "ливень (короткий)" },
      { en: "breeze", ru: "лёгкий ветер" },
      { en: "sunshine", ru: "солнечный свет" },
      { en: "drizzle", ru: "морось" },
      { en: "flood", ru: "наводнение" },
      { en: "heatwave", ru: "жара / волна жары" },
      { en: "temperature", ru: "температура" },
      { en: "degree", ru: "градус" },
      { en: "plus", ru: "плюс" },
      { en: "minus", ru: "минус" },
      { en: "zero", ru: "ноль" },
      { en: "freezing point", ru: "точка замерзания" },
      { en: "season", ru: "сезон" },
      { en: "spring", ru: "весна" },
      { en: "summer", ru: "лето" },
      { en: "autumn", ru: "осень" },
      { en: "fall", ru: "осень (амер.)" },
      { en: "winter", ru: "зима" },
      { en: "nature", ru: "природа" },
      { en: "forest", ru: "лес" },
      { en: "wood", ru: "лес (небольшой)" },
      { en: "tree", ru: "дерево" },
      { en: "flower", ru: "цветок" },
      { en: "grass", ru: "трава" },
      { en: "leaf", ru: "лист" },
      { en: "leaves", ru: "листья" },
      { en: "plant", ru: "растение" },
      { en: "bush", ru: "куст" },
      { en: "field", ru: "поле" },
      { en: "meadow", ru: "луг" },
      { en: "garden", ru: "сад" },
      { en: "park", ru: "парк" },
      { en: "river", ru: "река" },
      { en: "lake", ru: "озеро" },
      { en: "sea", ru: "море" },
      { en: "ocean", ru: "океан" },
      { en: "beach", ru: "пляж" },
      { en: "sand", ru: "песок" },
      { en: "island", ru: "остров" },
      { en: "waterfall", ru: "водопад" },
      { en: "stream", ru: "ручей" },
      { en: "mountain", ru: "гора" },
      { en: "hill", ru: "холм" },
      { en: "valley", ru: "долина" },
      { en: "desert", ru: "пустыня" },
      { en: "cliff", ru: "скала" },
      { en: "volcano", ru: "вулкан" },
      { en: "rock", ru: "камень" },
      { en: "stone", ru: "камень" },
      { en: "cave", ru: "пещера" },
      { en: "sky", ru: "небо" },
      { en: "star", ru: "звезда" },
      { en: "moon", ru: "луна" },
      { en: "planet", ru: "планета" },
      { en: "earth", ru: "земля" },
      { en: "animal", ru: "животное" },
      { en: "bird", ru: "птица" },
      { en: "dog", ru: "собака" },
      { en: "cat", ru: "кошка" },
      { en: "horse", ru: "лошадь" },
      { en: "cow", ru: "корова" },
      { en: "sheep", ru: "овца" },
      { en: "pig", ru: "свинья" },
      { en: "fish", ru: "рыба" },
      { en: "butterfly", ru: "бабочка" },
      { en: "bee", ru: "пчела" },
      { en: "insect", ru: "насекомое" },
      { en: "wildlife", ru: "дикая природа" },
      { en: "environment", ru: "окружающая среда" },
      { en: "climate", ru: "климат" },
      { en: "boiling", ru: "очень жарко" },
      { en: "wet", ru: "мокрый" },
    ],
    "глаголы": [
      { en: "be", ru: "быть" },
      { en: "have", ru: "иметь" },
      { en: "do", ru: "делать" },
      { en: "go", ru: "идти, ехать" },
      { en: "come", ru: "приходить" },
      { en: "get", ru: "получать, добираться" },
      { en: "make", ru: "делать (создавать)" },
      { en: "take", ru: "брать" },
      { en: "give", ru: "давать" },
      { en: "put", ru: "класть" },
      { en: "say", ru: "говорить, сказать" },
      { en: "tell", ru: "рассказывать" },
      { en: "ask", ru: "спрашивать" },
      { en: "answer", ru: "отвечать" },
      { en: "speak", ru: "говорить" },
      { en: "talk", ru: "разговаривать" },
      { en: "listen", ru: "слушать" },
      { en: "hear", ru: "слышать" },
      { en: "see", ru: "видеть" },
      { en: "look", ru: "смотреть" },
      { en: "watch", ru: "смотреть (наблюдать)" },
      { en: "read", ru: "читать" },
      { en: "write", ru: "писать" },
      { en: "eat", ru: "есть" },
      { en: "drink", ru: "пить" },
      { en: "sleep", ru: "спать" },
      { en: "wake up", ru: "просыпаться" },
      { en: "get up", ru: "вставать" },
      { en: "work", ru: "работать" },
      { en: "study", ru: "учиться" },
      { en: "learn", ru: "учить" },
      { en: "teach", ru: "учить (преподавать)" },
      { en: "know", ru: "знать" },
      { en: "think", ru: "думать" },
      { en: "understand", ru: "понимать" },
      { en: "remember", ru: "помнить" },
      { en: "forget", ru: "забывать" },
      { en: "like", ru: "нравиться" },
      { en: "love", ru: "любить" },
      { en: "hate", ru: "ненавидеть" },
      { en: "want", ru: "хотеть" },
      { en: "need", ru: "нуждаться" },
      { en: "live", ru: "жить" },
      { en: "play", ru: "играть" },
      { en: "sing", ru: "петь" },
      { en: "dance", ru: "танцевать" },
      { en: "run", ru: "бежать" },
      { en: "walk", ru: "идти пешком" },
      { en: "buy", ru: "покупать" },
      { en: "help", ru: "помогать" },
    ],
    "прилагательные": [
      { en: "big", ru: "большой" },
      { en: "small", ru: "маленький" },
      { en: "little", ru: "маленький, небольшой" },
      { en: "tall", ru: "высокий" },
      { en: "short", ru: "короткий, низкий" },
      { en: "long", ru: "длинный" },
      { en: "high", ru: "высокий" },
      { en: "low", ru: "низкий" },
      { en: "good", ru: "хороший" },
      { en: "bad", ru: "плохой" },
      { en: "nice", ru: "приятный" },
      { en: "beautiful", ru: "красивый" },
      { en: "pretty", ru: "симпатичный" },
      { en: "ugly", ru: "некрасивый" },
      { en: "new", ru: "новый" },
      { en: "old", ru: "старый" },
      { en: "young", ru: "молодой" },
      { en: "happy", ru: "счастливый" },
      { en: "sad", ru: "грустный" },
      { en: "angry", ru: "злой" },
      { en: "tired", ru: "усталый" },
      { en: "hungry", ru: "голодный" },
      { en: "thirsty", ru: "испытывающий жажду" },
      { en: "sick", ru: "больной" },
      { en: "healthy", ru: "здоровый" },
      { en: "strong", ru: "сильный" },
      { en: "weak", ru: "слабый" },
      { en: "fast", ru: "быстрый" },
      { en: "slow", ru: "медленный" },
      { en: "easy", ru: "лёгкий, простой" },
      { en: "hard", ru: "трудный, твёрдый" },
      { en: "difficult", ru: "сложный" },
      { en: "cheap", ru: "дешёвый" },
      { en: "expensive", ru: "дорогой" },
      { en: "free", ru: "бесплатный, свободный" },
      { en: "busy", ru: "занятой" },
      { en: "lazy", ru: "ленивый" },
      { en: "clever", ru: "умный" },
      { en: "smart", ru: "умный, элегантный" },
      { en: "stupid", ru: "глупый" },
      { en: "funny", ru: "смешной" },
      { en: "boring", ru: "скучный" },
      { en: "interesting", ru: "интересный" },
      { en: "important", ru: "важный" },
      { en: "ready", ru: "готовый" },
      { en: "empty", ru: "пустой" },
      { en: "full", ru: "полный" },
      { en: "open", ru: "открытый" },
      { en: "closed", ru: "закрытый" },
      { en: "right", ru: "правильный, правый" },
      { en: "wrong", ru: "неправильный" },
    ],
    "маркетинг": [
      { en: "brand", ru: "бренд" },
      { en: "company", ru: "компания" },
      { en: "product", ru: "продукт, товар" },
      { en: "service", ru: "услуга" },
      { en: "customer", ru: "клиент, покупатель" },
      { en: "market", ru: "рынок" },
      { en: "price", ru: "цена" },
      { en: "sale", ru: "продажа" },
      { en: "sales", ru: "продажи, объём продаж" },
      { en: "discount", ru: "скидка" },
      { en: "ad", ru: "реклама (одно объявление)" },
      { en: "advertising", ru: "реклама (сфера, деятельность)" },
      { en: "advertise", ru: "рекламировать" },
      { en: "promote", ru: "продвигать" },
      { en: "buy", ru: "покупать" },
      { en: "sell", ru: "продавать" },
      { en: "offer", ru: "предложение" },
      { en: "free", ru: "бесплатный" },
      { en: "cheap", ru: "дешёвый" },
      { en: "expensive", ru: "дорогой" },
      { en: "quality", ru: "качество" },
      { en: "popular", ru: "популярный" },
      { en: "logo", ru: "логотип" },
      { en: "slogan", ru: "слоган" },
      { en: "packaging", ru: "упаковка" },
      { en: "website", ru: "сайт" },
      { en: "online store", ru: "интернет-магазин" },
      { en: "social media", ru: "соцсети" },
      { en: "post", ru: "пост, публикация" },
      { en: "photo", ru: "фото" },
      { en: "video", ru: "видео" },
      { en: "email", ru: "письмо, имейл" },
      { en: "team", ru: "команда" },
      { en: "meeting", ru: "встреча, созвон" },
      { en: "report", ru: "отчёт" },
    ],
  },
};

// --- Уровень C1 ---
const SEED_SHARED_LIBRARY_C1 = {
  difficulty: "C1",
  topics: {
    "глобпроблемы": [
      { en: "climate change", ru: "изменение климата" },
      { en: "global warming", ru: "глобальное потепление" },
      { en: "greenhouse gas emissions", ru: "выбросы парниковых газов" },
      { en: "carbon footprint", ru: "углеродный след" },
      { en: "deforestation", ru: "вырубка лесов" },
      { en: "biodiversity loss", ru: "утрата биоразнообразия" },
      { en: "renewable energy", ru: "возобновляемая энергия" },
      { en: "fossil fuels", ru: "ископаемое топливо" },
      { en: "sustainability", ru: "устойчивое развитие" },
      { en: "overpopulation", ru: "перенаселение" },
      { en: "food insecurity", ru: "продовольственная нестабильность" },
      { en: "famine", ru: "голод (массовый)" },
      { en: "drought", ru: "засуха" },
      { en: "natural disaster", ru: "стихийное бедствие" },
      { en: "rising sea levels", ru: "повышение уровня моря" },
      { en: "pollution", ru: "загрязнение" },
      { en: "plastic waste", ru: "пластиковые отходы" },
      { en: "ozone depletion", ru: "разрушение озонового слоя" },
      { en: "endangered species", ru: "вымирающие виды" },
      { en: "extinction", ru: "вымирание" },
      { en: "scarcity of resources", ru: "нехватка ресурсов" },
      { en: "water shortage", ru: "дефицит воды" },
      { en: "migration crisis", ru: "миграционный кризис" },
      { en: "refugee", ru: "беженец" },
      { en: "displacement", ru: "вынужденное переселение" },
      { en: "poverty", ru: "бедность" },
      { en: "inequality", ru: "неравенство" },
      { en: "wealth gap", ru: "разрыв в благосостоянии" },
      { en: "humanitarian aid", ru: "гуманитарная помощь" },
      { en: "pandemic", ru: "пандемия" },
      { en: "public health", ru: "общественное здравоохранение" },
      { en: "human rights", ru: "права человека" },
      { en: "exploitation", ru: "эксплуатация" },
      { en: "sweatshop", ru: "потогонное производство" },
      { en: "child labour", ru: "детский труд" },
      { en: "arms race", ru: "гонка вооружений" },
      { en: "nuclear proliferation", ru: "распространение ядерного оружия" },
      { en: "terrorism", ru: "терроризм" },
      { en: "geopolitical tension", ru: "геополитическая напряженность" },
      { en: "sanctions", ru: "санкции" },
      { en: "trade war", ru: "торговая война" },
      { en: "economic collapse", ru: "экономический крах" },
      { en: "recession", ru: "рецессия" },
      { en: "unemployment", ru: "безработица" },
      { en: "urbanisation", ru: "урбанизация" },
      { en: "slum", ru: "трущобы" },
      { en: "overconsumption", ru: "избыточное потребление" },
      { en: "carbon neutrality", ru: "углеродная нейтральность" },
      { en: "mitigation", ru: "смягчение последствий" },
      { en: "adaptation", ru: "адаптация" },
      { en: "sustainable development", ru: "устойчивое развитие" },
      { en: "the developing world", ru: "развивающиеся страны" },
      { en: "foreign aid", ru: "иностранная помощь" },
      { en: "debt relief", ru: "списание долга" },
      { en: "corruption", ru: "коррупция" },
      { en: "governance", ru: "государственное управление" },
      { en: "activism", ru: "активизм" },
      { en: "grassroots movement", ru: "низовое движение" },
      { en: "to tackle a problem", ru: "решать проблему" },
      { en: "to raise awareness", ru: "повышать осведомленность" },
      { en: "to address an issue", ru: "заниматься проблемой" },
      { en: "pressing", ru: "насущный, неотложный" },
      { en: "to exacerbate", ru: "усугублять" },
      { en: "to alleviate", ru: "облегчать, смягчать" },
      { en: "far-reaching consequences", ru: "далеко идущие последствия" },
    ],
    "философия": [
      { en: "ethics", ru: "этика" },
      { en: "morality", ru: "нравственность" },
      { en: "moral dilemma", ru: "моральная дилемма" },
      { en: "virtue", ru: "добродетель" },
      { en: "vice", ru: "порок" },
      { en: "integrity", ru: "честность, цельность" },
      { en: "conscience", ru: "совесть" },
      { en: "free will", ru: "свобода воли" },
      { en: "determinism", ru: "детерминизм" },
      { en: "existence", ru: "существование" },
      { en: "consciousness", ru: "сознание" },
      { en: "perception", ru: "восприятие" },
      { en: "reality", ru: "реальность" },
      { en: "truth", ru: "истина" },
      { en: "knowledge", ru: "знание" },
      { en: "belief", ru: "убеждение" },
      { en: "reasoning", ru: "рассуждение" },
      { en: "logic", ru: "логика" },
      { en: "argument", ru: "довод, аргумент" },
      { en: "premise", ru: "предпосылка, посылка" },
      { en: "conclusion", ru: "вывод" },
      { en: "fallacy", ru: "логическая ошибка" },
      { en: "contradiction", ru: "противоречие" },
      { en: "paradox", ru: "парадокс" },
      { en: "assumption", ru: "допущение" },
      { en: "justification", ru: "обоснование" },
      { en: "to justify", ru: "обосновывать" },
      { en: "rational", ru: "рациональный" },
      { en: "subjective", ru: "субъективный" },
      { en: "objective", ru: "объективный" },
      { en: "relativism", ru: "релятивизм" },
      { en: "absolute", ru: "абсолютный" },
      { en: "principle", ru: "принцип" },
      { en: "value", ru: "ценность" },
      { en: "norm", ru: "норма" },
      { en: "duty", ru: "долг" },
      { en: "obligation", ru: "обязательство" },
      { en: "righteous", ru: "праведный" },
      { en: "just", ru: "справедливый" },
      { en: "fairness", ru: "справедливость" },
      { en: "equity", ru: "равенство, беспристрастность" },
      { en: "the greater good", ru: "всеобщее благо" },
      { en: "utilitarianism", ru: "утилитаризм" },
      { en: "consequence", ru: "последствие" },
      { en: "intent", ru: "намерение" },
      { en: "accountability", ru: "ответственность" },
      { en: "blame", ru: "вина" },
      { en: "guilt", ru: "чувство вины" },
      { en: "empathy", ru: "эмпатия" },
      { en: "compassion", ru: "сострадание" },
      { en: "altruism", ru: "альтруизм" },
      { en: "self-interest", ru: "личный интерес" },
      { en: "hypocrisy", ru: "лицемерие" },
      { en: "dogma", ru: "догма" },
      { en: "doctrine", ru: "доктрина" },
      { en: "ideology", ru: "идеология" },
      { en: "to ponder", ru: "размышлять" },
      { en: "to contemplate", ru: "созерцать, обдумывать" },
      { en: "profound", ru: "глубокий" },
      { en: "inherent", ru: "присущий, врожденный" },
      { en: "to uphold a value", ru: "придерживаться ценности" },
      { en: "to question", ru: "подвергать сомнению" },
      { en: "worldview", ru: "мировоззрение" },
      { en: "the human condition", ru: "человеческая природа" },
    ],
    "право": [
      { en: "law", ru: "закон" },
      { en: "legislation", ru: "законодательство" },
      { en: "statute", ru: "нормативный акт" },
      { en: "regulation", ru: "постановление" },
      { en: "to enact a law", ru: "принимать закон" },
      { en: "to enforce", ru: "обеспечивать соблюдение" },
      { en: "jurisdiction", ru: "юрисдикция" },
      { en: "court", ru: "суд" },
      { en: "trial", ru: "судебный процесс" },
      { en: "hearing", ru: "слушание" },
      { en: "judge", ru: "судья" },
      { en: "jury", ru: "присяжные" },
      { en: "verdict", ru: "вердикт" },
      { en: "sentence", ru: "приговор" },
      { en: "to convict", ru: "осудить (признать виновным)" },
      { en: "to acquit", ru: "оправдать" },
      { en: "defendant", ru: "обвиняемый, ответчик" },
      { en: "plaintiff", ru: "истец" },
      { en: "prosecution", ru: "обвинение" },
      { en: "defence", ru: "защита" },
      { en: "attorney", ru: "адвокат, юрист" },
      { en: "testimony", ru: "показания" },
      { en: "evidence", ru: "доказательства" },
      { en: "witness", ru: "свидетель" },
      { en: "to plead guilty", ru: "признать вину" },
      { en: "alibi", ru: "алиби" },
      { en: "crime", ru: "преступление" },
      { en: "offence", ru: "правонарушение" },
      { en: "felony", ru: "тяжкое преступление" },
      { en: "misdemeanour", ru: "мелкое правонарушение" },
      { en: "fraud", ru: "мошенничество" },
      { en: "embezzlement", ru: "растрата" },
      { en: "bribery", ru: "взяточничество" },
      { en: "theft", ru: "кража" },
      { en: "burglary", ru: "кража со взломом" },
      { en: "assault", ru: "нападение" },
      { en: "homicide", ru: "убийство" },
      { en: "manslaughter", ru: "непредумышленное убийство" },
      { en: "perpetrator", ru: "преступник" },
      { en: "suspect", ru: "подозреваемый" },
      { en: "to arrest", ru: "арестовать" },
      { en: "to detain", ru: "задерживать" },
      { en: "custody", ru: "заключение под стражу" },
      { en: "bail", ru: "залог" },
      { en: "imprisonment", ru: "тюремное заключение" },
      { en: "parole", ru: "условно-досрочное освобождение" },
      { en: "probation", ru: "условный срок" },
      { en: "fine", ru: "штраф" },
      { en: "liability", ru: "юридическая ответственность" },
      { en: "negligence", ru: "халатность" },
      { en: "breach of contract", ru: "нарушение договора" },
      { en: "lawsuit", ru: "судебный иск" },
      { en: "to sue", ru: "подавать в суд" },
      { en: "to appeal", ru: "обжаловать" },
      { en: "settlement", ru: "урегулирование" },
      { en: "the rule of law", ru: "верховенство права" },
      { en: "due process", ru: "надлежащая правовая процедура" },
      { en: "presumption of innocence", ru: "презумпция невиновности" },
      { en: "to uphold the law", ru: "соблюдать закон" },
      { en: "to break the law", ru: "нарушать закон" },
      { en: "deterrent", ru: "сдерживающий фактор" },
      { en: "rehabilitation", ru: "реабилитация" },
    ],
    "наука": [
      { en: "research", ru: "исследование" },
      { en: "study", ru: "исследование (научная работа)" },
      { en: "hypothesis", ru: "гипотеза" },
      { en: "theory", ru: "теория" },
      { en: "experiment", ru: "эксперимент" },
      { en: "methodology", ru: "методология" },
      { en: "data", ru: "данные" },
      { en: "sample", ru: "выборка" },
      { en: "sample size", ru: "размер выборки" },
      { en: "variable", ru: "переменная" },
      { en: "control group", ru: "контрольная группа" },
      { en: "to conduct research", ru: "проводить исследование" },
      { en: "to carry out a study", ru: "проводить исследование" },
      { en: "findings", ru: "результаты, выводы" },
      { en: "results", ru: "результаты" },
      { en: "outcome", ru: "итог, исход" },
      { en: "evidence", ru: "доказательства" },
      { en: "to analyse", ru: "анализировать" },
      { en: "analysis", ru: "анализ" },
      { en: "to measure", ru: "измерять" },
      { en: "measurement", ru: "измерение" },
      { en: "to observe", ru: "наблюдать" },
      { en: "observation", ru: "наблюдение" },
      { en: "to test", ru: "проверять, тестировать" },
      { en: "trial", ru: "испытание" },
      { en: "clinical trial", ru: "клиническое испытание" },
      { en: "peer review", ru: "рецензирование" },
      { en: "to publish", ru: "публиковать" },
      { en: "journal", ru: "научный журнал" },
      { en: "paper", ru: "научная статья" },
      { en: "abstract", ru: "аннотация" },
      { en: "literature review", ru: "обзор литературы" },
      { en: "citation", ru: "цитирование, ссылка" },
      { en: "to replicate", ru: "воспроизводить" },
      { en: "reproducibility", ru: "воспроизводимость" },
      { en: "correlation", ru: "корреляция" },
      { en: "causation", ru: "причинно-следственная связь" },
      { en: "significant", ru: "значимый" },
      { en: "statistically significant", ru: "статистически значимый" },
      { en: "bias", ru: "систематическая ошибка, предвзятость" },
      { en: "margin of error", ru: "погрешность" },
      { en: "to validate", ru: "подтверждать, проверять" },
      { en: "to verify", ru: "проверять" },
      { en: "to confirm", ru: "подтверждать" },
      { en: "to refute", ru: "опровергать" },
      { en: "to disprove", ru: "опровергать" },
      { en: "empirical", ru: "эмпирический" },
      { en: "quantitative", ru: "количественный" },
      { en: "qualitative", ru: "качественный" },
      { en: "to estimate", ru: "оценивать" },
      { en: "estimate", ru: "оценка" },
      { en: "breakthrough", ru: "прорыв" },
      { en: "discovery", ru: "открытие" },
      { en: "innovation", ru: "инновация" },
      { en: "to invent", ru: "изобретать" },
      { en: "patent", ru: "патент" },
      { en: "laboratory", ru: "лаборатория" },
      { en: "specimen", ru: "образец" },
      { en: "to simulate", ru: "моделировать" },
      { en: "model", ru: "модель" },
      { en: "framework", ru: "концептуальная схема" },
      { en: "assumption", ru: "допущение" },
      { en: "limitation", ru: "ограничение" },
      { en: "scope", ru: "охват, рамки" },
      { en: "to draw a conclusion", ru: "делать вывод" },
      { en: "to interpret", ru: "интерпретировать" },
      { en: "underlying", ru: "лежащий в основе" },
      { en: "robust", ru: "надежный, устойчивый" },
      { en: "preliminary", ru: "предварительный" },
    ],
    "академический": [
      { en: "academia", ru: "академическая среда" },
      { en: "scholar", ru: "ученый" },
      { en: "scholarship", ru: "научная деятельность, стипендия" },
      { en: "discipline", ru: "дисциплина, область" },
      { en: "field of study", ru: "область исследования" },
      { en: "thesis", ru: "тезис, диссертация" },
      { en: "dissertation", ru: "диссертация" },
      { en: "argument", ru: "аргумент, тезис" },
      { en: "claim", ru: "утверждение" },
      { en: "to argue", ru: "утверждать, доказывать" },
      { en: "to assert", ru: "утверждать" },
      { en: "to contend", ru: "утверждать" },
      { en: "to maintain", ru: "придерживаться мнения" },
      { en: "to acknowledge", ru: "признавать" },
      { en: "to address", ru: "рассматривать (вопрос)" },
      { en: "to examine", ru: "исследовать" },
      { en: "to explore", ru: "изучать" },
      { en: "to investigate", ru: "исследовать" },
      { en: "to demonstrate", ru: "демонстрировать" },
      { en: "to illustrate", ru: "иллюстрировать" },
      { en: "to highlight", ru: "подчеркивать" },
      { en: "to emphasise", ru: "акцентировать" },
      { en: "to outline", ru: "обрисовать" },
      { en: "to summarise", ru: "резюмировать" },
      { en: "to evaluate", ru: "оценивать" },
      { en: "to assess", ru: "оценивать" },
      { en: "to critique", ru: "критически разбирать" },
      { en: "critical", ru: "критический" },
      { en: "coherent", ru: "связный, логичный" },
      { en: "coherence", ru: "связность" },
      { en: "to substantiate", ru: "обосновывать" },
      { en: "to elaborate", ru: "развивать мысль" },
      { en: "notion", ru: "понятие" },
      { en: "concept", ru: "концепция" },
      { en: "perspective", ru: "точка зрения" },
      { en: "approach", ru: "подход" },
      { en: "framework", ru: "структура, рамки" },
      { en: "paradigm", ru: "парадигма" },
      { en: "to conceptualise", ru: "осмыслять" },
      { en: "nuance", ru: "нюанс" },
      { en: "implication", ru: "следствие, подтекст" },
      { en: "to imply", ru: "подразумевать" },
      { en: "to infer", ru: "делать вывод" },
      { en: "inference", ru: "умозаключение" },
      { en: "rationale", ru: "обоснование" },
      { en: "premise", ru: "посылка" },
      { en: "to presuppose", ru: "предполагать" },
      { en: "explicit", ru: "явный" },
      { en: "implicit", ru: "неявный" },
      { en: "ambiguous", ru: "неоднозначный" },
      { en: "to clarify", ru: "прояснять" },
      { en: "to define", ru: "определять" },
      { en: "definition", ru: "определение" },
      { en: "respectively", ru: "соответственно" },
      { en: "namely", ru: "а именно" },
      { en: "thereby", ru: "тем самым" },
      { en: "hence", ru: "следовательно" },
      { en: "notwithstanding", ru: "несмотря на" },
      { en: "albeit", ru: "хотя и" },
      { en: "to a certain extent", ru: "до определенной степени" },
      { en: "in this regard", ru: "в этом отношении" },
      { en: "with respect to", ru: "в отношении" },
      { en: "prior to", ru: "до, перед" },
      { en: "subsequent", ru: "последующий" },
      { en: "comprehensive", ru: "всесторонний" },
    ],
    "переговоры": [
      { en: "negotiation", ru: "переговоры" },
      { en: "to negotiate", ru: "вести переговоры" },
      { en: "deal", ru: "сделка" },
      { en: "agreement", ru: "соглашение" },
      { en: "contract", ru: "контракт" },
      { en: "terms", ru: "условия" },
      { en: "clause", ru: "пункт (договора)" },
      { en: "proposal", ru: "предложение" },
      { en: "counteroffer", ru: "встречное предложение" },
      { en: "to make a concession", ru: "идти на уступку" },
      { en: "concession", ru: "уступка" },
      { en: "compromise", ru: "компромисс" },
      { en: "to compromise", ru: "идти на компромисс" },
      { en: "common ground", ru: "общая позиция" },
      { en: "to reach an agreement", ru: "достичь соглашения" },
      { en: "to close a deal", ru: "заключить сделку" },
      { en: "to seal a deal", ru: "скрепить сделку" },
      { en: "bargaining power", ru: "переговорная сила" },
      { en: "leverage", ru: "рычаг влияния" },
      { en: "to leverage", ru: "использовать (как рычаг)" },
      { en: "stakeholder", ru: "заинтересованная сторона" },
      { en: "counterpart", ru: "партнер по переговорам" },
      { en: "mutual benefit", ru: "взаимная выгода" },
      { en: "win-win", ru: "взаимовыгодный" },
      { en: "trade-off", ru: "компромисс, размен" },
      { en: "bottom line", ru: "итоговая позиция, минимум" },
      { en: "deal-breaker", ru: "неприемлемое условие" },
      { en: "to walk away", ru: "выйти из сделки" },
      { en: "to back down", ru: "отступить" },
      { en: "to stand firm", ru: "стоять на своем" },
      { en: "to meet halfway", ru: "пойти навстречу" },
      { en: "incentive", ru: "стимул" },
      { en: "to incentivise", ru: "стимулировать" },
      { en: "to undercut", ru: "сбивать цену" },
      { en: "margin", ru: "маржа, наценка" },
      { en: "markup", ru: "наценка" },
      { en: "quote", ru: "ценовое предложение" },
      { en: "to quote a price", ru: "назвать цену" },
      { en: "discount", ru: "скидка" },
      { en: "bulk discount", ru: "оптовая скидка" },
      { en: "to haggle", ru: "торговаться" },
      { en: "to barter", ru: "обмениваться" },
      { en: "clincher", ru: "решающий аргумент" },
      { en: "to finalise", ru: "завершать, оформлять" },
      { en: "binding", ru: "обязательный (юридически)" },
      { en: "non-binding", ru: "необязательный" },
      { en: "in good faith", ru: "добросовестно" },
      { en: "to honour an agreement", ru: "соблюдать договоренность" },
      { en: "to renege", ru: "отказаться от обещанного" },
      { en: "breach", ru: "нарушение" },
      { en: "liability", ru: "ответственность" },
      { en: "to delegate", ru: "делегировать" },
      { en: "to defer", ru: "откладывать" },
      { en: "deadlock", ru: "тупик" },
      { en: "stalemate", ru: "безвыходное положение" },
      { en: "to break the deadlock", ru: "выйти из тупика" },
      { en: "ultimatum", ru: "ультиматум" },
      { en: "to give and take", ru: "взаимные уступки" },
      { en: "vendor", ru: "поставщик" },
      { en: "procurement", ru: "закупки" },
      { en: "to outsource", ru: "передавать на аутсорс" },
      { en: "to scale", ru: "масштабировать" },
      { en: "projected revenue", ru: "прогнозируемая выручка" },
      { en: "overheads", ru: "накладные расходы" },
    ],
    "литература": [
      { en: "metaphor", ru: "метафора" },
      { en: "simile", ru: "сравнение" },
      { en: "personification", ru: "олицетворение" },
      { en: "hyperbole", ru: "гипербола" },
      { en: "understatement", ru: "преуменьшение" },
      { en: "irony", ru: "ирония" },
      { en: "sarcasm", ru: "сарказм" },
      { en: "satire", ru: "сатира" },
      { en: "allegory", ru: "аллегория" },
      { en: "symbolism", ru: "символизм" },
      { en: "imagery", ru: "образность" },
      { en: "motif", ru: "мотив" },
      { en: "theme", ru: "тема" },
      { en: "tone", ru: "тон" },
      { en: "mood", ru: "настроение" },
      { en: "foreshadowing", ru: "предзнаменование" },
      { en: "flashback", ru: "ретроспекция" },
      { en: "allusion", ru: "аллюзия, отсылка" },
      { en: "juxtaposition", ru: "противопоставление" },
      { en: "oxymoron", ru: "оксюморон" },
      { en: "paradox", ru: "парадокс" },
      { en: "pun", ru: "каламбур" },
      { en: "alliteration", ru: "аллитерация" },
      { en: "assonance", ru: "ассонанс" },
      { en: "onomatopoeia", ru: "звукоподражание" },
      { en: "rhyme", ru: "рифма" },
      { en: "rhythm", ru: "ритм" },
      { en: "meter", ru: "метр (стихотворный)" },
      { en: "verse", ru: "стих, строфа" },
      { en: "stanza", ru: "строфа" },
      { en: "prose", ru: "проза" },
      { en: "narrative", ru: "повествование" },
      { en: "narrator", ru: "рассказчик" },
      { en: "first-person", ru: "от первого лица" },
      { en: "omniscient", ru: "всеведущий" },
      { en: "point of view", ru: "точка зрения" },
      { en: "protagonist", ru: "главный герой" },
      { en: "antagonist", ru: "антагонист" },
      { en: "character development", ru: "развитие персонажа" },
      { en: "foil", ru: "персонаж-контраст" },
      { en: "plot", ru: "сюжет" },
      { en: "subplot", ru: "побочная сюжетная линия" },
      { en: "climax", ru: "кульминация" },
      { en: "denouement", ru: "развязка" },
      { en: "exposition", ru: "экспозиция" },
      { en: "conflict", ru: "конфликт" },
      { en: "twist", ru: "неожиданный поворот" },
      { en: "cliffhanger", ru: "интрига в финале" },
      { en: "genre", ru: "жанр" },
      { en: "to convey", ru: "передавать (смысл)" },
      { en: "to evoke", ru: "вызывать (чувство)" },
      { en: "to depict", ru: "изображать" },
      { en: "to portray", ru: "изображать" },
      { en: "connotation", ru: "коннотация" },
      { en: "denotation", ru: "прямое значение" },
      { en: "ambiguity", ru: "неоднозначность" },
      { en: "diction", ru: "выбор слов, слог" },
      { en: "syntax", ru: "синтаксис" },
      { en: "figurative", ru: "образный" },
      { en: "literal", ru: "буквальный" },
      { en: "vivid", ru: "яркий" },
      { en: "poignant", ru: "трогательный" },
    ],
    "психология": [
      { en: "behaviour", ru: "поведение" },
      { en: "cognition", ru: "познание" },
      { en: "subconscious", ru: "подсознание" },
      { en: "mindset", ru: "мышление, установка" },
      { en: "attitude", ru: "отношение" },
      { en: "emotion", ru: "эмоция" },
      { en: "temperament", ru: "темперамент" },
      { en: "personality", ru: "личность" },
      { en: "trait", ru: "черта характера" },
      { en: "introvert", ru: "интроверт" },
      { en: "extrovert", ru: "экстраверт" },
      { en: "self-esteem", ru: "самооценка" },
      { en: "self-awareness", ru: "самосознание" },
      { en: "motivation", ru: "мотивация" },
      { en: "instinct", ru: "инстинкт" },
      { en: "impulse", ru: "порыв, импульс" },
      { en: "habit", ru: "привычка" },
      { en: "conditioning", ru: "обусловливание" },
      { en: "reinforcement", ru: "подкрепление" },
      { en: "trigger", ru: "триггер, спусковой крючок" },
      { en: "response", ru: "реакция" },
      { en: "stimulus", ru: "стимул, раздражитель" },
      { en: "coping mechanism", ru: "механизм совладания" },
      { en: "defence mechanism", ru: "защитный механизм" },
      { en: "denial", ru: "отрицание" },
      { en: "projection", ru: "проекция" },
      { en: "repression", ru: "вытеснение" },
      { en: "cognitive dissonance", ru: "когнитивный диссонанс" },
      { en: "confirmation bias", ru: "предвзятость подтверждения" },
      { en: "peer pressure", ru: "давление сверстников" },
      { en: "conformity", ru: "конформизм" },
      { en: "resilience", ru: "устойчивость, жизнестойкость" },
      { en: "anxiety", ru: "тревожность" },
      { en: "stress", ru: "стресс" },
      { en: "burnout", ru: "выгорание" },
      { en: "trauma", ru: "травма" },
      { en: "phobia", ru: "фобия" },
      { en: "obsession", ru: "навязчивая идея" },
      { en: "compulsion", ru: "компульсия" },
      { en: "disorder", ru: "расстройство" },
      { en: "therapy", ru: "терапия" },
      { en: "to cope with", ru: "справляться с" },
      { en: "to internalise", ru: "усваивать (внутренне)" },
      { en: "to suppress", ru: "подавлять" },
      { en: "to project", ru: "проецировать" },
      { en: "to rationalise", ru: "рационализировать" },
      { en: "to perceive", ru: "воспринимать" },
      { en: "nature versus nurture", ru: "природа против воспитания" },
      { en: "nurture", ru: "воспитание, среда" },
      { en: "to condition", ru: "формировать (поведение)" },
      { en: "deep-seated", ru: "глубоко укоренившийся" },
      { en: "to manifest", ru: "проявляться" },
      { en: "self-fulfilling prophecy", ru: "самосбывающееся пророчество" },
      { en: "gut feeling", ru: "интуитивное чувство" },
      { en: "state of mind", ru: "душевное состояние" },
      { en: "frame of mind", ru: "настрой" },
    ],
    "медицина": [
      { en: "health", ru: "здоровье" },
      { en: "illness", ru: "болезнь" },
      { en: "disease", ru: "заболевание" },
      { en: "condition", ru: "состояние, заболевание" },
      { en: "symptom", ru: "симптом" },
      { en: "diagnosis", ru: "диагноз" },
      { en: "to diagnose", ru: "диагностировать" },
      { en: "prognosis", ru: "прогноз" },
      { en: "treatment", ru: "лечение" },
      { en: "to treat", ru: "лечить" },
      { en: "remedy", ru: "средство, лекарство" },
      { en: "cure", ru: "излечение, лекарство" },
      { en: "to cure", ru: "излечивать" },
      { en: "recovery", ru: "выздоровление" },
      { en: "to recover", ru: "выздоравливать" },
      { en: "relapse", ru: "рецидив" },
      { en: "chronic", ru: "хронический" },
      { en: "acute", ru: "острый" },
      { en: "terminal", ru: "неизлечимый" },
      { en: "contagious", ru: "заразный" },
      { en: "infectious", ru: "инфекционный" },
      { en: "outbreak", ru: "вспышка" },
      { en: "epidemic", ru: "эпидемия" },
      { en: "pandemic", ru: "пандемия" },
      { en: "immune system", ru: "иммунная система" },
      { en: "immunity", ru: "иммунитет" },
      { en: "vaccine", ru: "вакцина" },
      { en: "vaccination", ru: "вакцинация" },
      { en: "antibiotic", ru: "антибиотик" },
      { en: "prescription", ru: "рецепт" },
      { en: "to prescribe", ru: "выписывать (лекарство)" },
      { en: "dose", ru: "доза" },
      { en: "dosage", ru: "дозировка" },
      { en: "side effect", ru: "побочный эффект" },
      { en: "overdose", ru: "передозировка" },
      { en: "surgery", ru: "операция, хирургия" },
      { en: "to undergo surgery", ru: "перенести операцию" },
      { en: "procedure", ru: "процедура" },
      { en: "to operate", ru: "оперировать" },
      { en: "transplant", ru: "трансплантация" },
      { en: "to monitor", ru: "наблюдать, отслеживать" },
      { en: "to screen", ru: "обследовать" },
      { en: "check-up", ru: "осмотр" },
      { en: "GP", ru: "терапевт (врач общей практики)" },
      { en: "specialist", ru: "специалист" },
      { en: "referral", ru: "направление к врачу" },
      { en: "ward", ru: "больничная палата" },
      { en: "intensive care", ru: "интенсивная терапия" },
      { en: "emergency", ru: "неотложная помощь" },
      { en: "first aid", ru: "первая помощь" },
      { en: "to resuscitate", ru: "реанимировать" },
      { en: "mental health", ru: "психическое здоровье" },
      { en: "depression", ru: "депрессия" },
      { en: "to deteriorate", ru: "ухудшаться" },
      { en: "to relieve", ru: "облегчать" },
      { en: "to alleviate", ru: "облегчать" },
      { en: "to manage a condition", ru: "контролировать заболевание" },
      { en: "preventive", ru: "профилактический" },
      { en: "to prevent", ru: "предотвращать" },
      { en: "nutrition", ru: "питание" },
      { en: "to boost immunity", ru: "укреплять иммунитет" },
      { en: "chronic fatigue", ru: "хроническая усталость" },
    ],
    "идиомы": [
      { en: "to bite the bullet", ru: "стиснуть зубы и сделать" },
      { en: "to hit the nail on the head", ru: "попасть в точку" },
      { en: "to cut corners", ru: "халтурить, экономить на качестве" },
      { en: "to get the ball rolling", ru: "запустить дело" },
      { en: "to be on the same page", ru: "понимать одинаково" },
      { en: "to think outside the box", ru: "мыслить нестандартно" },
      { en: "to take something into account", ru: "учитывать что-либо" },
      { en: "to come across as", ru: "производить впечатление" },
      { en: "to get cold feet", ru: "струсить в последний момент" },
      { en: "to break the ice", ru: "растопить лед, разрядить обстановку" },
      { en: "to play it by ear", ru: "действовать по обстоятельствам" },
      { en: "to be in the same boat", ru: "быть в одной лодке" },
      { en: "to go the extra mile", ru: "приложить дополнительные усилия" },
      { en: "to cut to the chase", ru: "перейти к сути" },
      { en: "to be a blessing in disguise", ru: "не было бы счастья, да несчастье помогло" },
      { en: "to jump on the bandwagon", ru: "примкнуть к большинству" },
      { en: "to be over the moon", ru: "быть на седьмом небе" },
      { en: "to feel under the weather", ru: "неважно себя чувствовать" },
      { en: "to have a lot on one's plate", ru: "быть перегруженным" },
      { en: "to get on like a house on fire", ru: "прекрасно ладить" },
      { en: "to bend over backwards", ru: "из кожи вон лезть" },
      { en: "to be snowed under", ru: "быть заваленным работой" },
      { en: "to call it a day", ru: "закончить на сегодня" },
      { en: "to touch base", ru: "связаться, свериться" },
      { en: "to be up in the air", ru: "быть нерешенным" },
      { en: "to take a rain check", ru: "перенести на потом" },
      { en: "to be a piece of cake", ru: "проще простого" },
      { en: "to ring a bell", ru: "звучать знакомо" },
      { en: "to be the last straw", ru: "последняя капля" },
      { en: "to add insult to injury", ru: "усугубить положение" },
      { en: "to beat around the bush", ru: "ходить вокруг да около" },
      { en: "to be in hot water", ru: "быть в беде" },
      { en: "to let the cat out of the bag", ru: "проболтаться" },
      { en: "to spill the beans", ru: "выдать секрет" },
      { en: "to be on the ball", ru: "быть расторопным" },
      { en: "to pull someone's leg", ru: "разыгрывать кого-то" },
      { en: "to be a wake-up call", ru: "быть тревожным сигналом" },
      { en: "to face the music", ru: "отвечать за последствия" },
      { en: "to get out of hand", ru: "выйти из-под контроля" },
      { en: "to be worth a shot", ru: "стоит попробовать" },
      { en: "to keep an eye on", ru: "присматривать за" },
      { en: "to be in someone's shoes", ru: "быть на чьем-то месте" },
      { en: "to read between the lines", ru: "читать между строк" },
      { en: "to sit on the fence", ru: "занимать нейтральную позицию" },
      { en: "to throw in the towel", ru: "сдаться" },
      { en: "to be water under the bridge", ru: "дело прошлое" },
      { en: "once in a blue moon", ru: "очень редко" },
      { en: "to take with a grain of salt", ru: "относиться скептически" },
      { en: "the bottom line", ru: "суть, главное" },
      { en: "to be a game changer", ru: "кардинально менять ситуацию" },
      { en: "to move the goalposts", ru: "менять правила по ходу" },
      { en: "to be par for the course", ru: "в порядке вещей" },
      { en: "at the end of the day", ru: "в конечном итоге" },
      { en: "to wrap one's head around", ru: "осмыслить, понять" },
      { en: "to be a long shot", ru: "маловероятный вариант" },
      { en: "to go down a rabbit hole", ru: "уйти с головой во что-то" },
      { en: "to be the elephant in the room", ru: "очевидная замалчиваемая проблема" },
      { en: "to be on thin ice", ru: "быть в рискованном положении" },
      { en: "to bite off more than one can chew", ru: "переоценить свои силы" },
      { en: "to keep one's options open", ru: "не связывать себя обязательствами" },
      { en: "food for thought", ru: "пища для размышлений" },
      { en: "to have second thoughts", ru: "засомневаться" },
    ],
    "маркетинг": [
      { en: "product-market fit", ru: "попадание продукта в рынок" },
      { en: "category creation", ru: "создание новой категории" },
      { en: "share of voice", ru: "доля бренда в медиапространстве" },
      { en: "brand equity", ru: "накопленный капитал бренда" },
      { en: "brand salience", ru: "насколько бренд первым приходит в голову" },
      { en: "differentiation", ru: "чем мы отличаемся от остальных" },
      { en: "commoditize", ru: "обезличить, свести к цене" },
      { en: "price elasticity", ru: "чувствительность спроса к цене" },
      { en: "margin", ru: "маржа" },
      { en: "payback period", ru: "срок окупаемости" },
      { en: "blended CAC", ru: "усреднённая стоимость привлечения по всем каналам" },
      { en: "incrementality", ru: "реальный прирост именно от канала" },
      { en: "halo effect", ru: "эффект ореола, побочная польза для других каналов" },
      { en: "cannibalization", ru: "каннибализация, отъедание у своего же канала" },
      { en: "audience saturation", ru: "насыщение аудитории" },
      { en: "diminishing returns", ru: "убывающая отдача от вложений" },
      { en: "media mix", ru: "распределение бюджета по каналам" },
      { en: "cohort", ru: "когорта" },
      { en: "statistical significance", ru: "статистическая значимость" },
      { en: "directional data", ru: "данные, задающие направление, но не точные" },
      { en: "proxy metric", ru: "метрика-заместитель" },
      { en: "vanity metric", ru: "красивая метрика, не связанная с деньгами" },
      { en: "north star metric", ru: "главная метрика продукта" },
      { en: "narrative", ru: "нарратив, история, которую мы продаём" },
      { en: "reframe", ru: "сместить рамку, подать под другим углом" },
      { en: "positioning statement", ru: "формулировка позиционирования" },
      { en: "land and expand", ru: "зайти малым, потом расширяться внутри клиента" },
      { en: "flywheel", ru: "маховик, самораскручивающийся рост" },
      { en: "moat", ru: "устойчивое преимущество, которое сложно скопировать" },
      { en: "table stakes", ru: "базовый минимум, без которого не заходишь на рынок" },
      { en: "headwinds", ru: "встречные обстоятельства" },
      { en: "tailwinds", ru: "попутные обстоятельства, рынок помогает" },
      { en: "de-risk", ru: "снизить риск заранее" },
      { en: "sunk cost", ru: "уже потраченное, что не вернуть" },
      { en: "hedge", ru: "подстраховаться" },
      { en: "greenlight", ru: "дать зелёный свет" },
      { en: "sunset a product", ru: "закрыть, вывести из линейки" },
      { en: "soft launch", ru: "тихий запуск на узкой аудитории" },
      { en: "socialize an idea", ru: "обкатать идею на людях до решения" },
      { en: "get buy-in", ru: "заручиться поддержкой" },
      { en: "make the case for smth", ru: "обосновать, аргументировать" },
      { en: "build consensus", ru: "свести всех к общему решению" },
      { en: "caveat", ru: "оговорка, важное «но»" },
      { en: "back-of-the-envelope", ru: "прикидка на коленке" },
      { en: "take smth with a grain of salt", ru: "относиться с осторожностью" },
      { en: "overpromise and underdeliver", ru: "наобещать и не вытянуть" },
      { en: "set expectations", ru: "обозначить, чего ждать" },
      { en: "manage up", ru: "выстраивать коммуникацию с руководством" },
    ],
  },
};

// --- Уровень B1 ---
const SEED_SHARED_LIBRARY_B1 = {
  difficulty: "B1",
  topics: {
    "работа": [
      { en: "job", ru: "работа (место)" },
      { en: "career", ru: "карьера" },
      { en: "employer", ru: "работодатель" },
      { en: "employee", ru: "сотрудник" },
      { en: "colleague", ru: "коллега" },
      { en: "boss", ru: "начальник" },
      { en: "staff", ru: "персонал" },
      { en: "to apply for a job", ru: "подавать на работу" },
      { en: "application", ru: "заявление / отклик" },
      { en: "CV", ru: "резюме" },
      { en: "job interview", ru: "собеседование" },
      { en: "to hire", ru: "нанимать" },
      { en: "to employ", ru: "нанимать / трудоустраивать" },
      { en: "to be employed", ru: "быть трудоустроенным" },
      { en: "unemployed", ru: "безработный" },
      { en: "to earn", ru: "зарабатывать" },
      { en: "salary", ru: "зарплата (оклад)" },
      { en: "wage", ru: "зарплата (почасовая)" },
      { en: "to get a promotion", ru: "получить повышение" },
      { en: "to be promoted", ru: "быть повышенным" },
      { en: "full-time", ru: "полная занятость" },
      { en: "part-time", ru: "частичная занятость" },
      { en: "to work overtime", ru: "работать сверхурочно" },
      { en: "day off", ru: "выходной" },
      { en: "to take a break", ru: "делать перерыв" },
      { en: "deadline", ru: "срок сдачи" },
      { en: "task", ru: "задача" },
      { en: "meeting", ru: "совещание" },
      { en: "project", ru: "проект" },
      { en: "to be in charge of", ru: "отвечать за" },
      { en: "responsibility", ru: "обязанность" },
      { en: "skill", ru: "навык" },
      { en: "experience", ru: "опыт" },
      { en: "training", ru: "обучение" },
      { en: "to resign", ru: "увольняться" },
      { en: "to quit", ru: "бросать (работу)" },
      { en: "to fire", ru: "увольнять" },
      { en: "to be made redundant", ru: "попасть под сокращение" },
      { en: "workplace", ru: "рабочее место" },
      { en: "office", ru: "офис" },
      { en: "to work from home", ru: "работать из дома" },
      { en: "teamwork", ru: "командная работа" },
      { en: "to get on with colleagues", ru: "ладить с коллегами" },
      { en: "busy", ru: "занятый" },
      { en: "stressful", ru: "стрессовый" },
      { en: "rewarding", ru: "приносящий удовлетворение" },
      { en: "to look for a job", ru: "искать работу" },
      { en: "to fill in a form", ru: "заполнять анкету" },
      { en: "qualification", ru: "квалификация" },
      { en: "to be good at", ru: "быть хорошим в" },
    ],
    "образование": [
      { en: "to study", ru: "учиться / изучать" },
      { en: "to learn", ru: "учить / узнавать" },
      { en: "subject", ru: "предмет" },
      { en: "lesson", ru: "урок" },
      { en: "classroom", ru: "класс" },
      { en: "schedule", ru: "расписание" },
      { en: "homework", ru: "домашнее задание" },
      { en: "to do homework", ru: "делать домашку" },
      { en: "to take notes", ru: "делать заметки" },
      { en: "to pass an exam", ru: "сдать экзамен" },
      { en: "to fail an exam", ru: "провалить экзамен" },
      { en: "to take an exam", ru: "сдавать экзамен" },
      { en: "mark / grade", ru: "оценка" },
      { en: "to revise", ru: "повторять (к экзамену)" },
      { en: "to make progress", ru: "делать успехи" },
      { en: "to get a degree", ru: "получить диплом" },
      { en: "university", ru: "университет" },
      { en: "college", ru: "колледж" },
      { en: "student", ru: "студент" },
      { en: "teacher", ru: "учитель" },
      { en: "lecturer", ru: "преподаватель (вуза)" },
      { en: "lecture", ru: "лекция" },
      { en: "course", ru: "курс" },
      { en: "to enrol", ru: "записаться (на курс)" },
      { en: "to graduate", ru: "окончить (вуз)" },
      { en: "graduation", ru: "выпуск" },
      { en: "scholarship", ru: "стипендия" },
      { en: "tuition fee", ru: "плата за обучение" },
      { en: "knowledge", ru: "знания" },
      { en: "to memorise", ru: "заучивать" },
      { en: "to concentrate", ru: "сосредотачиваться" },
      { en: "to pay attention", ru: "быть внимательным" },
      { en: "to make a mistake", ru: "делать ошибку" },
      { en: "to correct", ru: "исправлять" },
      { en: "to explain", ru: "объяснять" },
      { en: "to understand", ru: "понимать" },
      { en: "to give a presentation", ru: "делать презентацию" },
      { en: "to do research", ru: "проводить исследование" },
      { en: "to hand in", ru: "сдавать (работу)" },
      { en: "deadline", ru: "срок сдачи" },
      { en: "distance learning", ru: "дистанционное обучение" },
      { en: "to drop out", ru: "бросить учёбу" },
      { en: "to attend", ru: "посещать (занятия)" },
      { en: "qualification", ru: "квалификация" },
      { en: "to be good at a subject", ru: "быть способным к предмету" },
      { en: "to fall behind", ru: "отставать" },
      { en: "to catch up", ru: "догонять" },
      { en: "educated", ru: "образованный" },
      { en: "academic", ru: "учебный / академический" },
    ],
    "отношения": [
      { en: "relationship", ru: "отношения" },
      { en: "friendship", ru: "дружба" },
      { en: "to make friends", ru: "заводить друзей" },
      { en: "close friend", ru: "близкий друг" },
      { en: "to get to know", ru: "узнать (познакомиться)" },
      { en: "to meet", ru: "встречать / знакомиться" },
      { en: "to fall in love", ru: "влюбиться" },
      { en: "to be in love", ru: "быть влюблённым" },
      { en: "couple", ru: "пара" },
      { en: "partner", ru: "партнёр" },
      { en: "boyfriend", ru: "парень" },
      { en: "girlfriend", ru: "девушка" },
      { en: "to date", ru: "встречаться" },
      { en: "to get engaged", ru: "обручиться" },
      { en: "to get married", ru: "пожениться" },
      { en: "marriage", ru: "брак" },
      { en: "wedding", ru: "свадьба" },
      { en: "husband", ru: "муж" },
      { en: "wife", ru: "жена" },
      { en: "to trust", ru: "доверять" },
      { en: "to support", ru: "поддерживать" },
      { en: "to argue", ru: "спорить / ссориться" },
      { en: "argument", ru: "ссора / спор" },
      { en: "to break up", ru: "расстаться" },
      { en: "to split up", ru: "разойтись" },
      { en: "to get divorced", ru: "развестись" },
      { en: "divorce", ru: "развод" },
      { en: "to get on well", ru: "хорошо ладить" },
      { en: "to have a lot in common", ru: "иметь много общего" },
      { en: "to spend time together", ru: "проводить время вместе" },
      { en: "to keep in touch", ru: "поддерживать связь" },
      { en: "to lose touch", ru: "потерять связь" },
      { en: "to make up", ru: "мириться" },
      { en: "to apologise", ru: "извиняться" },
      { en: "to forgive", ru: "прощать" },
      { en: "loyal", ru: "верный" },
      { en: "honest", ru: "честный" },
      { en: "caring", ru: "заботливый" },
      { en: "jealous", ru: "ревнивый" },
      { en: "to cheat on", ru: "изменять" },
      { en: "to miss someone", ru: "скучать по кому-то" },
      { en: "neighbour", ru: "сосед" },
      { en: "acquaintance", ru: "знакомый" },
      { en: "to rely on", ru: "полагаться на" },
      { en: "to get along", ru: "уживаться" },
      { en: "to fall out", ru: "поссориться" },
      { en: "to introduce", ru: "представлять (знакомить)" },
      { en: "to invite", ru: "приглашать" },
      { en: "relative", ru: "родственник" },
    ],
    "сми": [
      { en: "news", ru: "новости" },
      { en: "the media", ru: "СМИ" },
      { en: "newspaper", ru: "газета" },
      { en: "magazine", ru: "журнал" },
      { en: "article", ru: "статья" },
      { en: "headline", ru: "заголовок" },
      { en: "journalist", ru: "журналист" },
      { en: "reporter", ru: "репортёр" },
      { en: "to report", ru: "сообщать" },
      { en: "report", ru: "репортаж / отчёт" },
      { en: "to broadcast", ru: "транслировать" },
      { en: "channel", ru: "канал" },
      { en: "to interview", ru: "брать интервью" },
      { en: "interview", ru: "интервью" },
      { en: "front page", ru: "первая полоса" },
      { en: "breaking news", ru: "срочные новости" },
      { en: "current affairs", ru: "текущие события" },
      { en: "to publish", ru: "публиковать" },
      { en: "to be published", ru: "быть опубликованным" },
      { en: "to announce", ru: "объявлять" },
      { en: "announcement", ru: "объявление" },
      { en: "to cover a story", ru: "освещать событие" },
      { en: "coverage", ru: "освещение (в СМИ)" },
      { en: "press", ru: "пресса" },
      { en: "the public", ru: "общественность" },
      { en: "audience", ru: "аудитория" },
      { en: "viewer", ru: "зритель" },
      { en: "reader", ru: "читатель" },
      { en: "to subscribe", ru: "подписываться" },
      { en: "subscription", ru: "подписка" },
      { en: "fake news", ru: "фейковые новости" },
      { en: "reliable", ru: "надёжный (источник)" },
      { en: "biased", ru: "предвзятый" },
      { en: "to spread", ru: "распространять(ся)" },
      { en: "rumour", ru: "слух" },
      { en: "scandal", ru: "скандал" },
      { en: "to censor", ru: "цензурировать" },
      { en: "freedom of the press", ru: "свобода прессы" },
      { en: "editor", ru: "редактор" },
      { en: "weather forecast", ru: "прогноз погоды" },
      { en: "to keep up with the news", ru: "следить за новостями" },
      { en: "to go viral", ru: "стать вирусным" },
      { en: "trending", ru: "в тренде" },
      { en: "source", ru: "источник" },
      { en: "headline news", ru: "главные новости" },
      { en: "documentary", ru: "документальный фильм" },
      { en: "to update", ru: "обновлять" },
      { en: "in the spotlight", ru: "в центре внимания" },
    ],
    "экология": [
      { en: "the environment", ru: "окружающая среда" },
      { en: "environmental", ru: "экологический" },
      { en: "nature", ru: "природа" },
      { en: "climate", ru: "климат" },
      { en: "climate change", ru: "изменение климата" },
      { en: "global warming", ru: "глобальное потепление" },
      { en: "pollution", ru: "загрязнение" },
      { en: "to pollute", ru: "загрязнять" },
      { en: "polluted", ru: "загрязнённый" },
      { en: "waste", ru: "отходы / мусор" },
      { en: "rubbish", ru: "мусор" },
      { en: "litter", ru: "мусор (на улице)" },
      { en: "to throw away", ru: "выбрасывать" },
      { en: "to recycle", ru: "перерабатывать" },
      { en: "recycling", ru: "переработка" },
      { en: "to reuse", ru: "использовать повторно" },
      { en: "to reduce", ru: "сокращать" },
      { en: "plastic", ru: "пластик" },
      { en: "packaging", ru: "упаковка" },
      { en: "energy", ru: "энергия" },
      { en: "to save energy", ru: "экономить энергию" },
      { en: "to waste", ru: "тратить впустую" },
      { en: "renewable", ru: "возобновляемый" },
      { en: "solar power", ru: "солнечная энергия" },
      { en: "wind power", ru: "энергия ветра" },
      { en: "fossil fuels", ru: "ископаемое топливо" },
      { en: "to protect", ru: "защищать" },
      { en: "to harm", ru: "вредить" },
      { en: "harmful", ru: "вредный" },
      { en: "endangered", ru: "под угрозой исчезновения" },
      { en: "species", ru: "вид (животных)" },
      { en: "wildlife", ru: "дикая природа" },
      { en: "forest", ru: "лес" },
      { en: "to cut down trees", ru: "вырубать деревья" },
      { en: "deforestation", ru: "вырубка лесов" },
      { en: "to plant trees", ru: "сажать деревья" },
      { en: "ocean", ru: "океан" },
      { en: "to clean up", ru: "убирать (очищать)" },
      { en: "eco-friendly", ru: "экологичный" },
      { en: "sustainable", ru: "устойчивый / экологичный" },
      { en: "carbon footprint", ru: "углеродный след" },
      { en: "to cause", ru: "вызывать (быть причиной)" },
      { en: "effect", ru: "последствие / эффект" },
      { en: "drought", ru: "засуха" },
      { en: "flood", ru: "наводнение" },
      { en: "natural disaster", ru: "стихийное бедствие" },
      { en: "to raise awareness", ru: "повышать осведомлённость" },
    ],
    "технологии": [
      { en: "technology", ru: "технология" },
      { en: "device", ru: "устройство" },
      { en: "gadget", ru: "гаджет" },
      { en: "screen", ru: "экран" },
      { en: "to switch on", ru: "включать" },
      { en: "to switch off", ru: "выключать" },
      { en: "to download", ru: "скачивать" },
      { en: "to upload", ru: "загружать (в сеть)" },
      { en: "to install", ru: "устанавливать" },
      { en: "to update", ru: "обновлять" },
      { en: "app", ru: "приложение" },
      { en: "software", ru: "программное обеспечение" },
      { en: "file", ru: "файл" },
      { en: "folder", ru: "папка" },
      { en: "to save", ru: "сохранять" },
      { en: "to delete", ru: "удалять" },
      { en: "password", ru: "пароль" },
      { en: "to log in", ru: "входить (в аккаунт)" },
      { en: "to log out", ru: "выходить (из аккаунта)" },
      { en: "to sign up", ru: "регистрироваться" },
      { en: "account", ru: "аккаунт" },
      { en: "the Internet", ru: "интернет" },
      { en: "website", ru: "сайт" },
      { en: "web page", ru: "веб-страница" },
      { en: "link", ru: "ссылка" },
      { en: "to click", ru: "нажимать (кликать)" },
      { en: "to browse", ru: "просматривать (в сети)" },
      { en: "search engine", ru: "поисковик" },
      { en: "to search for", ru: "искать" },
      { en: "online", ru: "онлайн" },
      { en: "offline", ru: "офлайн" },
      { en: "to connect", ru: "подключать(ся)" },
      { en: "connection", ru: "подключение" },
      { en: "Wi-Fi", ru: "вай-фай" },
      { en: "network", ru: "сеть" },
      { en: "social media", ru: "соцсети" },
      { en: "to post", ru: "публиковать" },
      { en: "to share", ru: "делиться" },
      { en: "to comment", ru: "комментировать" },
      { en: "to like", ru: "ставить лайк" },
      { en: "to follow", ru: "подписываться" },
      { en: "message", ru: "сообщение" },
      { en: "to text", ru: "писать сообщения" },
      { en: "video call", ru: "видеозвонок" },
      { en: "to charge", ru: "заряжать" },
      { en: "battery", ru: "батарея / аккумулятор" },
      { en: "data", ru: "данные" },
      { en: "virus", ru: "вирус" },
    ],
    "кулинария": [
      { en: "recipe", ru: "рецепт" },
      { en: "ingredient", ru: "ингредиент" },
      { en: "to prepare", ru: "готовить (подготавливать)" },
      { en: "to cook", ru: "готовить" },
      { en: "to bake", ru: "печь" },
      { en: "to fry", ru: "жарить" },
      { en: "to boil", ru: "варить / кипятить" },
      { en: "to roast", ru: "запекать / жарить (в духовке)" },
      { en: "to grill", ru: "готовить на гриле" },
      { en: "to steam", ru: "готовить на пару" },
      { en: "to mix", ru: "смешивать" },
      { en: "to stir", ru: "помешивать" },
      { en: "to add", ru: "добавлять" },
      { en: "to chop", ru: "нарезать (крупно)" },
      { en: "to slice", ru: "нарезать ломтиками" },
      { en: "to peel", ru: "чистить (овощи)" },
      { en: "to pour", ru: "наливать" },
      { en: "to taste", ru: "пробовать на вкус" },
      { en: "flavour", ru: "вкус / аромат" },
      { en: "spicy", ru: "острый" },
      { en: "sweet", ru: "сладкий" },
      { en: "sour", ru: "кислый" },
      { en: "bitter", ru: "горький" },
      { en: "salty", ru: "солёный" },
      { en: "fresh", ru: "свежий" },
      { en: "frozen", ru: "замороженный" },
      { en: "raw", ru: "сырой" },
      { en: "ripe", ru: "спелый" },
      { en: "dish", ru: "блюдо" },
      { en: "meal", ru: "приём пищи" },
      { en: "starter", ru: "закуска" },
      { en: "main course", ru: "основное блюдо" },
      { en: "dessert", ru: "десерт" },
      { en: "portion", ru: "порция" },
      { en: "to serve", ru: "подавать (на стол)" },
      { en: "to feed", ru: "кормить" },
      { en: "to be on a diet", ru: "быть на диете" },
      { en: "vegetarian", ru: "вегетарианский" },
      { en: "to put on weight", ru: "набирать вес" },
      { en: "tasty", ru: "вкусный" },
      { en: "delicious", ru: "очень вкусный" },
      { en: "disgusting", ru: "отвратительный" },
      { en: "to follow a recipe", ru: "следовать рецепту" },
      { en: "cookbook", ru: "кулинарная книга" },
      { en: "oven", ru: "духовка" },
      { en: "saucepan", ru: "кастрюля" },
      { en: "frying pan", ru: "сковорода" },
      { en: "leftovers", ru: "остатки еды" },
    ],
    "город": [
      { en: "city", ru: "город (крупный)" },
      { en: "town", ru: "город (небольшой)" },
      { en: "village", ru: "деревня" },
      { en: "the countryside", ru: "сельская местность" },
      { en: "suburb", ru: "пригород" },
      { en: "neighbourhood", ru: "район" },
      { en: "city centre", ru: "центр города" },
      { en: "downtown", ru: "центр (амер.)" },
      { en: "district", ru: "район / округ" },
      { en: "to live in", ru: "жить в" },
      { en: "resident", ru: "житель" },
      { en: "local", ru: "местный (житель)" },
      { en: "traffic", ru: "движение / транспорт" },
      { en: "traffic jam", ru: "пробка" },
      { en: "rush hour", ru: "час пик" },
      { en: "public transport", ru: "общественный транспорт" },
      { en: "to commute", ru: "ездить на работу" },
      { en: "underground / metro", ru: "метро" },
      { en: "bus stop", ru: "остановка" },
      { en: "to get around", ru: "передвигаться" },
      { en: "pedestrian", ru: "пешеход" },
      { en: "crossing", ru: "переход" },
      { en: "pavement", ru: "тротуар" },
      { en: "crowded", ru: "переполненный" },
      { en: "busy", ru: "оживлённый" },
      { en: "noisy", ru: "шумный" },
      { en: "quiet", ru: "тихий" },
      { en: "safe", ru: "безопасный" },
      { en: "dangerous", ru: "опасный" },
      { en: "to cross the road", ru: "переходить дорогу" },
      { en: "facilities", ru: "удобства / инфраструктура" },
      { en: "shopping centre", ru: "торговый центр" },
      { en: "skyscraper", ru: "небоскрёб" },
      { en: "building", ru: "здание" },
      { en: "flat / apartment", ru: "квартира" },
      { en: "block of flats", ru: "многоквартирный дом" },
      { en: "rent", ru: "аренда" },
      { en: "to rent", ru: "снимать (жильё)" },
      { en: "landlord", ru: "арендодатель" },
      { en: "cost of living", ru: "стоимость жизни" },
      { en: "lifestyle", ru: "образ жизни" },
      { en: "to move (house)", ru: "переезжать" },
      { en: "to settle", ru: "обосноваться" },
      { en: "green space", ru: "зелёная зона" },
      { en: "park", ru: "парк" },
      { en: "litter", ru: "мусор (на улице)" },
      { en: "streetlight", ru: "уличный фонарь" },
      { en: "to be within walking distance", ru: "быть в пешей доступности" },
    ],
    "реклама": [
      { en: "advertising", ru: "реклама (сфера)" },
      { en: "advertisement / advert / ad", ru: "рекламное объявление" },
      { en: "to advertise", ru: "рекламировать" },
      { en: "commercial", ru: "рекламный ролик" },
      { en: "billboard", ru: "рекламный щит" },
      { en: "poster", ru: "плакат" },
      { en: "brand", ru: "бренд" },
      { en: "logo", ru: "логотип" },
      { en: "slogan", ru: "слоган" },
      { en: "product", ru: "продукт" },
      { en: "to promote", ru: "продвигать" },
      { en: "promotion", ru: "продвижение / акция" },
      { en: "campaign", ru: "кампания" },
      { en: "to launch", ru: "запускать (продукт)" },
      { en: "target audience", ru: "целевая аудитория" },
      { en: "consumer", ru: "потребитель" },
      { en: "customer", ru: "клиент" },
      { en: "to attract", ru: "привлекать" },
      { en: "to persuade", ru: "убеждать" },
      { en: "to influence", ru: "влиять" },
      { en: "to sell", ru: "продавать" },
      { en: "sales", ru: "продажи" },
      { en: "to increase", ru: "увеличивать" },
      { en: "discount", ru: "скидка" },
      { en: "offer", ru: "предложение" },
      { en: "special offer", ru: "спецпредложение" },
      { en: "on sale", ru: "в продаже / по акции" },
      { en: "free sample", ru: "бесплатный образец" },
      { en: "to afford", ru: "позволить себе" },
      { en: "demand", ru: "спрос" },
      { en: "to launch a product", ru: "выпустить продукт" },
      { en: "market", ru: "рынок" },
      { en: "to compete", ru: "конкурировать" },
      { en: "competitor", ru: "конкурент" },
      { en: "brand new", ru: "совершенно новый" },
      { en: "logo design", ru: "дизайн логотипа" },
      { en: "eye-catching", ru: "привлекающий внимание" },
      { en: "to stand out", ru: "выделяться" },
      { en: "to make a profit", ru: "получать прибыль" },
      { en: "profit", ru: "прибыль" },
      { en: "to spend money on", ru: "тратить деньги на" },
      { en: "to be worth", ru: "стоить (того)" },
      { en: "catchy", ru: "запоминающийся" },
      { en: "trustworthy", ru: "заслуживающий доверия" },
      { en: "word of mouth", ru: "сарафанное радио" },
      { en: "to recommend", ru: "рекомендовать" },
      { en: "review", ru: "отзыв" },
    ],
    "маркетинг": [
      { en: "target audience", ru: "целевая аудитория" },
      { en: "brand awareness", ru: "узнаваемость бренда" },
      { en: "launch", ru: "запуск (продукта, кампании)" },
      { en: "run a campaign", ru: "вести кампанию" },
      { en: "reach", ru: "охват" },
      { en: "engagement", ru: "вовлечённость" },
      { en: "lead", ru: "лид, потенциальный клиент" },
      { en: "landing page", ru: "посадочная страница, лендинг" },
      { en: "conversion", ru: "конверсия" },
      { en: "conversion rate", ru: "процент конверсии" },
      { en: "click-through rate (CTR)", ru: "кликабельность" },
      { en: "ad spend", ru: "расходы на рекламу" },
      { en: "paid ads", ru: "платная реклама" },
      { en: "organic traffic", ru: "органический трафик" },
      { en: "copy", ru: "рекламный текст" },
      { en: "headline", ru: "заголовок" },
      { en: "call to action (CTA)", ru: "призыв к действию" },
      { en: "creative", ru: "рекламный материал, креатив" },
      { en: "asset", ru: "материал (баннер, видео, текст)" },
      { en: "channel", ru: "канал" },
      { en: "placement", ru: "место размещения" },
      { en: "impression", ru: "показ" },
      { en: "audience segment", ru: "сегмент аудитории" },
      { en: "brief", ru: "бриф, техзадание" },
      { en: "deliverable", ru: "то, что сдаём по итогу" },
      { en: "stakeholder", ru: "тот, кого касается решение" },
      { en: "milestone", ru: "контрольная точка" },
      { en: "mock-up", ru: "макет" },
      { en: "reach out to smb", ru: "написать, связаться" },
      { en: "follow up", ru: "вернуться к вопросу, напомнить" },
      { en: "sign off on smth", ru: "утвердить, согласовать" },
      { en: "share of the market", ru: "доля рынка" },
    ],
  },
};

// --- Уровень B2 ---
const SEED_SHARED_LIBRARY_B2 = {
  difficulty: "B2",
  topics: {
    "работа": [
      { en: "career path", ru: "карьерный путь" },
      { en: "to climb the career ladder", ru: "подниматься по карьерной лестнице" },
      { en: "to land a job", ru: "получить работу" },
      { en: "to apply for a position", ru: "подавать заявку на должность" },
      { en: "job interview", ru: "собеседование" },
      { en: "to be shortlisted", ru: "попасть в шорт-лист" },
      { en: "to hire", ru: "нанимать" },
      { en: "to be promoted", ru: "получить повышение" },
      { en: "promotion", ru: "повышение" },
      { en: "to resign", ru: "увольняться (по собственному)" },
      { en: "to quit a job", ru: "бросить работу" },
      { en: "to be made redundant", ru: "попасть под сокращение" },
      { en: "notice period", ru: "срок отработки при увольнении" },
      { en: "workload", ru: "объём работы" },
      { en: "to take on responsibilities", ru: "брать на себя обязанности" },
      { en: "to meet a deadline", ru: "уложиться в срок" },
      { en: "to be under pressure", ru: "быть под давлением" },
      { en: "work-life balance", ru: "баланс работы и жизни" },
      { en: "to work overtime", ru: "работать сверхурочно" },
      { en: "to burn out", ru: "выгорать" },
      { en: "to take a day off", ru: "взять выходной" },
      { en: "salary", ru: "оклад" },
      { en: "to negotiate a pay rise", ru: "договариваться о повышении зарплаты" },
      { en: "benefits", ru: "льготы и бонусы" },
      { en: "perks", ru: "дополнительные привилегии" },
      { en: "to work from home", ru: "работать из дома" },
      { en: "remote work", ru: "удалённая работа" },
      { en: "flexible hours", ru: "гибкий график" },
      { en: "colleague", ru: "коллега" },
      { en: "line manager", ru: "непосредственный руководитель" },
      { en: "to report to someone", ru: "подчиняться кому-то" },
      { en: "to be in charge of", ru: "отвечать за" },
      { en: "to delegate tasks", ru: "делегировать задачи" },
      { en: "teamwork", ru: "командная работа" },
      { en: "to meet expectations", ru: "оправдывать ожидания" },
      { en: "performance review", ru: "оценка эффективности" },
      { en: "to give feedback", ru: "давать обратную связь" },
      { en: "to set goals", ru: "ставить цели" },
      { en: "to gain experience", ru: "набираться опыта" },
      { en: "skill set", ru: "набор навыков" },
      { en: "to upskill", ru: "повышать квалификацию" },
      { en: "to switch careers", ru: "менять профессию" },
      { en: "freelance", ru: "фриланс" },
      { en: "self-employed", ru: "работающий на себя" },
      { en: "to run a business", ru: "вести бизнес" },
      { en: "networking", ru: "налаживание профессиональных связей" },
      { en: "to make a good impression", ru: "произвести хорошее впечатление" },
      { en: "CV (resume)", ru: "резюме" },
      { en: "cover letter", ru: "сопроводительное письмо" },
      { en: "job vacancy", ru: "вакансия" },
      { en: "to be qualified for", ru: "иметь квалификацию для" },
      { en: "dead-end job", ru: "бесперспективная работа" },
      { en: "demanding job", ru: "требовательная работа" },
      { en: "rewarding job", ru: "приносящая удовлетворение работа" },
      { en: "to take pride in", ru: "гордиться (своей работой)" },
      { en: "to call it a day", ru: "закончить работу на сегодня" },
    ],
    "образование": [
      { en: "to enrol in a course", ru: "записаться на курс" },
      { en: "to pursue a degree", ru: "получать степень" },
      { en: "undergraduate", ru: "студент бакалавриата" },
      { en: "postgraduate", ru: "аспирант / магистрант" },
      { en: "to major in", ru: "специализироваться на" },
      { en: "tuition fees", ru: "плата за обучение" },
      { en: "scholarship", ru: "стипендия (за заслуги)" },
      { en: "to apply to university", ru: "поступать в университет" },
      { en: "to graduate from", ru: "окончить (учебное заведение)" },
      { en: "to drop out", ru: "бросить учёбу" },
      { en: "lecture", ru: "лекция" },
      { en: "seminar", ru: "семинар" },
      { en: "tutorial", ru: "практическое занятие" },
      { en: "assignment", ru: "задание" },
      { en: "to hand in", ru: "сдавать (работу)" },
      { en: "deadline", ru: "срок сдачи" },
      { en: "to sit an exam", ru: "сдавать экзамен" },
      { en: "to pass with flying colours", ru: "сдать с блеском" },
      { en: "to fail an exam", ru: "провалить экзамен" },
      { en: "to resit", ru: "пересдавать" },
      { en: "to revise", ru: "повторять к экзамену" },
      { en: "to cram", ru: "зубрить в последний момент" },
      { en: "to take notes", ru: "делать заметки" },
      { en: "to keep up with", ru: "успевать за (программой)" },
      { en: "to fall behind", ru: "отставать" },
      { en: "demanding course", ru: "сложный курс" },
      { en: "to grasp a concept", ru: "уловить понятие" },
      { en: "to get the hang of", ru: "приноровиться к" },
      { en: "steep learning curve", ru: "крутая кривая обучения" },
      { en: "hands-on experience", ru: "практический опыт" },
      { en: "trial and error", ru: "метод проб и ошибок" },
      { en: "to broaden one's horizons", ru: "расширять кругозор" },
      { en: "lifelong learning", ru: "обучение длиною в жизнь" },
      { en: "to brush up on", ru: "освежить знания" },
      { en: "self-taught", ru: "самоучка" },
      { en: "to memorise", ru: "заучивать наизусть" },
      { en: "distance learning", ru: "дистанционное обучение" },
      { en: "mature student", ru: "взрослый студент" },
      { en: "to drop a subject", ru: "отказаться от предмета" },
      { en: "academic", ru: "академический / учёный" },
      { en: "qualification", ru: "квалификация / диплом" },
      { en: "to be well-read", ru: "быть начитанным" },
      { en: "knowledgeable", ru: "хорошо осведомлённый" },
      { en: "to motivate", ru: "мотивировать" },
      { en: "to procrastinate", ru: "откладывать на потом" },
      { en: "study skills", ru: "учебные навыки" },
      { en: "to attend classes", ru: "посещать занятия" },
      { en: "curriculum", ru: "учебная программа" },
      { en: "to specialise in", ru: "специализироваться в" },
      { en: "to retain information", ru: "удерживать информацию" },
      { en: "to apply knowledge", ru: "применять знания" },
      { en: "peer", ru: "сверстник / ровесник" },
      { en: "mentor", ru: "наставник" },
      { en: "to give a presentation", ru: "делать презентацию" },
      { en: "to do research", ru: "проводить исследование" },
      { en: "gap year", ru: "год перерыва перед учёбой" },
    ],
    "финансы": [
      { en: "to earn a living", ru: "зарабатывать на жизнь" },
      { en: "income", ru: "доход" },
      { en: "expenses", ru: "расходы" },
      { en: "to make ends meet", ru: "сводить концы с концами" },
      { en: "to be on a tight budget", ru: "быть в стеснённом бюджете" },
      { en: "to budget", ru: "планировать расходы" },
      { en: "to save up for", ru: "копить на" },
      { en: "savings", ru: "сбережения" },
      { en: "to put money aside", ru: "откладывать деньги" },
      { en: "to spend money on", ru: "тратить деньги на" },
      { en: "to splash out", ru: "потратиться (на дорогое)" },
      { en: "to be broke", ru: "быть на мели" },
      { en: "to be well off", ru: "быть обеспеченным" },
      { en: "to afford", ru: "позволить себе" },
      { en: "affordable", ru: "доступный по цене" },
      { en: "overpriced", ru: "завышенный по цене" },
      { en: "good value for money", ru: "выгодная покупка" },
      { en: "bargain", ru: "выгодная сделка / находка" },
      { en: "to be in debt", ru: "быть в долгах" },
      { en: "to owe money", ru: "быть должным деньги" },
      { en: "to pay off a loan", ru: "выплатить кредит" },
      { en: "to take out a loan", ru: "взять кредит" },
      { en: "mortgage", ru: "ипотека" },
      { en: "interest rate", ru: "процентная ставка" },
      { en: "to borrow", ru: "занимать (брать в долг)" },
      { en: "to lend", ru: "одалживать (давать в долг)" },
      { en: "to pay in instalments", ru: "платить в рассрочку" },
      { en: "bill", ru: "счёт (к оплате)" },
      { en: "to settle a bill", ru: "оплатить счёт" },
      { en: "to cut back on", ru: "сокращать траты на" },
      { en: "to live within one's means", ru: "жить по средствам" },
      { en: "to live beyond one's means", ru: "жить не по средствам" },
      { en: "disposable income", ru: "располагаемый доход" },
      { en: "financial security", ru: "финансовая стабильность" },
      { en: "to invest in", ru: "вкладывать в" },
      { en: "return on investment", ru: "доход от вложений" },
      { en: "to go bankrupt", ru: "обанкротиться" },
      { en: "pension", ru: "пенсия" },
      { en: "to retire", ru: "выходить на пенсию" },
      { en: "inheritance", ru: "наследство" },
      { en: "to inherit", ru: "наследовать" },
      { en: "to be ripped off", ru: "быть обманутым (переплатить)" },
      { en: "refund", ru: "возврат денег" },
      { en: "to get into debt", ru: "влезть в долги" },
      { en: "financially independent", ru: "финансово независимый" },
      { en: "to make a fortune", ru: "сколотить состояние" },
      { en: "to waste money", ru: "транжирить деньги" },
      { en: "thrifty", ru: "бережливый" },
      { en: "extravagant", ru: "расточительный" },
      { en: "to tighten one's belt", ru: "затянуть пояс" },
      { en: "nest egg", ru: "накопления на будущее" },
      { en: "to break the bank", ru: "сильно ударить по кошельку" },
      { en: "pocket money", ru: "карманные деньги" },
      { en: "cost of living", ru: "стоимость жизни" },
      { en: "to keep track of spending", ru: "следить за тратами" },
    ],
    "характер": [
      { en: "personality trait", ru: "черта характера" },
      { en: "outgoing", ru: "общительный" },
      { en: "reserved", ru: "сдержанный / замкнутый" },
      { en: "self-confident", ru: "уверенный в себе" },
      { en: "down-to-earth", ru: "приземлённый / простой" },
      { en: "easy-going", ru: "лёгкий в общении" },
      { en: "strong-willed", ru: "волевой" },
      { en: "stubborn", ru: "упрямый" },
      { en: "considerate", ru: "внимательный к другим" },
      { en: "thoughtful", ru: "заботливый / вдумчивый" },
      { en: "selfish", ru: "эгоистичный" },
      { en: "generous", ru: "щедрый" },
      { en: "ambitious", ru: "амбициозный" },
      { en: "laid-back", ru: "расслабленный / неторопливый" },
      { en: "sensitive", ru: "чувствительный" },
      { en: "moody", ru: "с переменчивым настроением" },
      { en: "short-tempered", ru: "вспыльчивый" },
      { en: "patient", ru: "терпеливый" },
      { en: "reliable", ru: "надёжный" },
      { en: "trustworthy", ru: "заслуживающий доверия" },
      { en: "to come across as", ru: "производить впечатление" },
      { en: "to take after", ru: "быть похожим (на родственника)" },
      { en: "to have a lot in common", ru: "иметь много общего" },
      { en: "to get on someone's nerves", ru: "действовать на нервы" },
      { en: "to be in a good mood", ru: "быть в хорошем настроении" },
      { en: "to be in a bad mood", ru: "быть в плохом настроении" },
      { en: "to cheer up", ru: "приободриться" },
      { en: "to calm down", ru: "успокоиться" },
      { en: "to lose one's temper", ru: "выйти из себя" },
      { en: "to be over the moon", ru: "быть на седьмом небе" },
      { en: "to be thrilled", ru: "быть в восторге" },
      { en: "to feel down", ru: "быть подавленным" },
      { en: "to be stressed out", ru: "быть в стрессе" },
      { en: "to be fed up with", ru: "быть сытым по горло" },
      { en: "to be scared stiff", ru: "сильно испугаться" },
      { en: "to be on edge", ru: "быть на взводе" },
      { en: "overwhelmed", ru: "перегруженный (эмоционально)" },
      { en: "content", ru: "довольный" },
      { en: "anxious", ru: "тревожный" },
      { en: "frustrated", ru: "раздражённый / разочарованный" },
      { en: "to bottle up feelings", ru: "держать чувства в себе" },
      { en: "to express emotions", ru: "выражать эмоции" },
      { en: "to put someone in a good mood", ru: "поднять кому-то настроение" },
      { en: "to take things personally", ru: "принимать всё на свой счёт" },
      { en: "self-aware", ru: "осознающий себя" },
      { en: "to have a sense of humour", ru: "иметь чувство юмора" },
      { en: "to bear a grudge", ru: "затаить обиду" },
      { en: "to be at ease", ru: "чувствовать себя свободно" },
      { en: "to feel under the weather", ru: "неважно себя чувствовать" },
      { en: "to be beside oneself", ru: "быть вне себя" },
      { en: "mixed feelings", ru: "смешанные чувства" },
      { en: "to get carried away", ru: "увлечься / перестараться" },
      { en: "to keep a cool head", ru: "сохранять холодную голову" },
      { en: "to be set in one's ways", ru: "быть консервативным в привычках" },
      { en: "upbeat", ru: "жизнерадостный" },
      { en: "witty", ru: "остроумный" },
    ],
    "отношения": [
      { en: "to get on well with", ru: "хорошо ладить с" },
      { en: "to build a relationship", ru: "выстраивать отношения" },
      { en: "close friend", ru: "близкий друг" },
      { en: "to make friends", ru: "заводить друзей" },
      { en: "to lose touch with", ru: "потерять связь с" },
      { en: "to keep in touch", ru: "поддерживать связь" },
      { en: "to have a falling-out", ru: "поссориться" },
      { en: "to make up", ru: "помириться" },
      { en: "to fall out with someone", ru: "рассориться с кем-то" },
      { en: "to take sides", ru: "принимать чью-то сторону" },
      { en: "to get along", ru: "уживаться" },
      { en: "mutual", ru: "взаимный" },
      { en: "to have something in common", ru: "иметь что-то общее" },
      { en: "acquaintance", ru: "знакомый" },
      { en: "to hit it off", ru: "сразу поладить" },
      { en: "to drift apart", ru: "отдалиться друг от друга" },
      { en: "to value someone", ru: "ценить кого-то" },
      { en: "to rely on", ru: "полагаться на" },
      { en: "to trust", ru: "доверять" },
      { en: "to let someone down", ru: "подвести кого-то" },
      { en: "to support", ru: "поддерживать" },
      { en: "to be there for someone", ru: "быть рядом в нужный момент" },
      { en: "to confide in", ru: "доверять секреты" },
      { en: "to look up to", ru: "брать пример с" },
      { en: "to take someone for granted", ru: "не ценить кого-то" },
      { en: "to compromise", ru: "идти на компромисс" },
      { en: "to resolve a conflict", ru: "разрешить конфликт" },
      { en: "misunderstanding", ru: "недопонимание" },
      { en: "to clear the air", ru: "прояснить отношения" },
      { en: "to apologise for", ru: "извиняться за" },
      { en: "to forgive", ru: "прощать" },
      { en: "to hold a grudge", ru: "держать обиду" },
      { en: "to get to know someone", ru: "узнать кого-то ближе" },
      { en: "to break up with", ru: "расстаться с" },
      { en: "to be in a relationship", ru: "быть в отношениях" },
      { en: "to settle down", ru: "остепениться" },
      { en: "to propose to someone", ru: "сделать предложение" },
      { en: "to be engaged", ru: "быть помолвленным" },
      { en: "to start a family", ru: "завести семью" },
      { en: "relative", ru: "родственник" },
      { en: "to bring up children", ru: "воспитывать детей" },
      { en: "to set a good example", ru: "подавать хороший пример" },
      { en: "to stay in touch", ru: "оставаться на связи" },
      { en: "to small talk", ru: "вести светскую беседу" },
      { en: "to break the ice", ru: "растопить лёд (в общении)" },
      { en: "to get a word in", ru: "вставить слово" },
      { en: "to talk things over", ru: "всё обсудить" },
      { en: "to see eye to eye", ru: "сходиться во взглядах" },
      { en: "to agree to disagree", ru: "остаться при своих мнениях" },
      { en: "sociable", ru: "общительный" },
      { en: "to socialise", ru: "общаться / вести социальную жизнь" },
      { en: "to gossip", ru: "сплетничать" },
      { en: "to interrupt", ru: "перебивать" },
      { en: "to come to an agreement", ru: "прийти к согласию" },
      { en: "to give someone a hand", ru: "помочь кому-то" },
      { en: "to fit in", ru: "влиться (в коллектив)" },
    ],
    "технологии": [
      { en: "device", ru: "устройство" },
      { en: "gadget", ru: "гаджет" },
      { en: "to download", ru: "скачивать" },
      { en: "to upload", ru: "загружать (в сеть)" },
      { en: "app", ru: "приложение" },
      { en: "to install", ru: "устанавливать" },
      { en: "to update", ru: "обновлять" },
      { en: "to charge a device", ru: "заряжать устройство" },
      { en: "battery life", ru: "время работы батареи" },
      { en: "screen time", ru: "экранное время" },
      { en: "to scroll", ru: "листать (ленту)" },
      { en: "social media", ru: "социальные сети" },
      { en: "to post", ru: "публиковать" },
      { en: "to share", ru: "делиться (контентом)" },
      { en: "to go viral", ru: "стать вирусным" },
      { en: "to follow", ru: "подписываться (на кого-то)" },
      { en: "follower", ru: "подписчик" },
      { en: "notification", ru: "уведомление" },
      { en: "to mute notifications", ru: "отключить уведомления" },
      { en: "to log in", ru: "входить в аккаунт" },
      { en: "to sign up", ru: "регистрироваться" },
      { en: "password", ru: "пароль" },
      { en: "to back up", ru: "делать резервную копию" },
      { en: "cloud", ru: "облако (хранилище)" },
      { en: "to stream", ru: "смотреть/слушать онлайн" },
      { en: "streaming service", ru: "стриминговый сервис" },
      { en: "to browse", ru: "просматривать (в сети)" },
      { en: "search engine", ru: "поисковик" },
      { en: "to google something", ru: "загуглить что-то" },
      { en: "online shopping", ru: "онлайн-покупки" },
      { en: "to add to cart", ru: "добавить в корзину" },
      { en: "user-friendly", ru: "удобный в использовании" },
      { en: "to crash", ru: "зависать / падать (о программе)" },
      { en: "to freeze", ru: "зависать (об экране)" },
      { en: "to reboot", ru: "перезагружать" },
      { en: "glitch", ru: "сбой / глюк" },
      { en: "Wi-Fi connection", ru: "подключение к Wi-Fi" },
      { en: "to be online", ru: "быть в сети" },
      { en: "to be offline", ru: "быть вне сети" },
      { en: "to text", ru: "писать смс / сообщения" },
      { en: "video call", ru: "видеозвонок" },
      { en: "voice message", ru: "голосовое сообщение" },
      { en: "to swipe", ru: "смахивать (по экрану)" },
      { en: "touchscreen", ru: "сенсорный экран" },
      { en: "to set up", ru: "настраивать (устройство)" },
      { en: "to sync", ru: "синхронизировать" },
      { en: "to be addicted to", ru: "быть зависимым от" },
      { en: "digital detox", ru: "цифровой детокс" },
      { en: "to spend hours online", ru: "проводить часы в сети" },
      { en: "to keep up with technology", ru: "успевать за технологиями" },
      { en: "out of date", ru: "устаревший" },
      { en: "cutting-edge", ru: "передовой" },
      { en: "to multitask", ru: "делать несколько дел сразу" },
      { en: "artificial intelligence", ru: "искусственный интеллект" },
      { en: "smart home", ru: "умный дом" },
      { en: "to rely on technology", ru: "полагаться на технологии" },
      { en: "data", ru: "данные" },
      { en: "privacy", ru: "конфиденциальность" },
    ],
    "путешествия": [
      { en: "to go abroad", ru: "ехать за границу" },
      { en: "destination", ru: "место назначения" },
      { en: "to book a flight", ru: "забронировать билет" },
      { en: "to pack", ru: "собирать вещи" },
      { en: "luggage", ru: "багаж" },
      { en: "hand luggage", ru: "ручная кладь" },
      { en: "to check in", ru: "зарегистрироваться (на рейс)" },
      { en: "boarding pass", ru: "посадочный талон" },
      { en: "to catch a flight", ru: "успеть на рейс" },
      { en: "to miss a flight", ru: "опоздать на рейс" },
      { en: "delay", ru: "задержка" },
      { en: "layover", ru: "пересадка с ожиданием" },
      { en: "jet lag", ru: "смена часовых поясов" },
      { en: "travel insurance", ru: "страховка путешественника" },
      { en: "itinerary", ru: "маршрут поездки" },
      { en: "sightseeing", ru: "осмотр достопримечательностей" },
      { en: "landmark", ru: "достопримечательность" },
      { en: "to explore", ru: "исследовать" },
      { en: "off the beaten track", ru: "вдали от туристических троп" },
      { en: "breathtaking", ru: "захватывающий дух" },
      { en: "to soak up the atmosphere", ru: "впитывать атмосферу" },
      { en: "local cuisine", ru: "местная кухня" },
      { en: "to try local food", ru: "пробовать местную еду" },
      { en: "souvenir", ru: "сувенир" },
      { en: "backpacking", ru: "путешествие с рюкзаком" },
      { en: "package holiday", ru: "тур «всё включено»" },
      { en: "to travel on a budget", ru: "путешествовать экономно" },
      { en: "all-inclusive", ru: "всё включено" },
      { en: "guided tour", ru: "экскурсия с гидом" },
      { en: "to get around", ru: "передвигаться (по городу)" },
      { en: "to lose one's way", ru: "заблудиться" },
      { en: "culture shock", ru: "культурный шок" },
      { en: "to adapt to", ru: "приспосабливаться к" },
      { en: "customs and traditions", ru: "обычаи и традиции" },
      { en: "cultural differences", ru: "культурные различия" },
      { en: "to broaden the mind", ru: "расширять кругозор" },
      { en: "homesick", ru: "тоскующий по дому" },
      { en: "to settle in", ru: "обживаться" },
      { en: "to immerse oneself in", ru: "погружаться в (культуру)" },
      { en: "language barrier", ru: "языковой барьер" },
      { en: "to pick up a language", ru: "нахвататься языка" },
      { en: "hospitality", ru: "гостеприимство" },
      { en: "tourist trap", ru: "туристическая ловушка" },
      { en: "peak season", ru: "высокий сезон" },
      { en: "off-season", ru: "низкий сезон" },
      { en: "to make a reservation", ru: "сделать бронь" },
      { en: "accommodation", ru: "жильё (для проживания)" },
      { en: "to hit the road", ru: "отправиться в путь" },
      { en: "travel light", ru: "путешествовать налегке" },
      { en: "to broaden one's perspective", ru: "расширять взгляды" },
      { en: "to venture out", ru: "выбираться (на вылазку)" },
      { en: "must-see", ru: "обязательное к посещению" },
      { en: "scenery", ru: "пейзаж" },
      { en: "vibrant", ru: "яркий / оживлённый" },
      { en: "to wander around", ru: "бродить вокруг" },
      { en: "to get a feel for", ru: "прочувствовать (место)" },
    ],
    "город": [
      { en: "to settle down", ru: "осесть / обосноваться" },
      { en: "to move house", ru: "переезжать" },
      { en: "to relocate", ru: "переезжать (в другой город/страну)" },
      { en: "suburb", ru: "пригород" },
      { en: "city centre", ru: "центр города" },
      { en: "neighbourhood", ru: "район (по соседству)" },
      { en: "neighbour", ru: "сосед" },
      { en: "residential area", ru: "жилой район" },
      { en: "to rent a flat", ru: "снимать квартиру" },
      { en: "landlord", ru: "арендодатель" },
      { en: "tenant", ru: "арендатор" },
      { en: "rent", ru: "арендная плата" },
      { en: "to own a property", ru: "владеть недвижимостью" },
      { en: "mortgage", ru: "ипотека" },
      { en: "to do up a place", ru: "делать ремонт" },
      { en: "spacious", ru: "просторный" },
      { en: "cramped", ru: "тесный" },
      { en: "cosy", ru: "уютный" },
      { en: "to commute", ru: "ездить на работу (издалека)" },
      { en: "rush hour", ru: "час пик" },
      { en: "public transport", ru: "общественный транспорт" },
      { en: "traffic jam", ru: "пробка" },
      { en: "congestion", ru: "перегруженность движения" },
      { en: "pedestrian", ru: "пешеход" },
      { en: "to get around on foot", ru: "передвигаться пешком" },
      { en: "amenities", ru: "удобства / инфраструктура" },
      { en: "within walking distance", ru: "в пешей доступности" },
      { en: "lively", ru: "оживлённый" },
      { en: "bustling", ru: "шумный и активный" },
      { en: "peaceful", ru: "спокойный / тихий" },
      { en: "overcrowded", ru: "перенаселённый" },
      { en: "cost of living", ru: "стоимость жизни" },
      { en: "standard of living", ru: "уровень жизни" },
      { en: "quality of life", ru: "качество жизни" },
      { en: "fast-paced", ru: "динамичный (о ритме)" },
      { en: "urban", ru: "городской" },
      { en: "rural", ru: "сельский" },
      { en: "the countryside", ru: "сельская местность" },
      { en: "green space", ru: "зелёная зона" },
      { en: "pollution", ru: "загрязнение" },
      { en: "noise pollution", ru: "шумовое загрязнение" },
      { en: "to put down roots", ru: "пустить корни" },
      { en: "local community", ru: "местное сообщество" },
      { en: "facilities", ru: "удобства / объекты" },
      { en: "high-rise", ru: "многоэтажка" },
      { en: "to be on the outskirts", ru: "быть на окраине" },
      { en: "convenient", ru: "удобно расположенный" },
      { en: "run-down", ru: "запущенный / обветшалый" },
      { en: "up-and-coming", ru: "перспективный (о районе)" },
      { en: "to get used to", ru: "привыкать к" },
      { en: "hustle and bustle", ru: "городская суета" },
      { en: "homeowner", ru: "домовладелец" },
      { en: "to share a flat", ru: "снимать квартиру вместе" },
      { en: "flatmate", ru: "сосед по квартире" },
      { en: "utilities", ru: "коммунальные услуги" },
    ],
    "здоровье": [
      { en: "to keep fit", ru: "поддерживать форму" },
      { en: "to work out", ru: "тренироваться" },
      { en: "to take up a sport", ru: "заняться спортом" },
      { en: "to go for a run", ru: "ходить на пробежку" },
      { en: "to stay in shape", ru: "оставаться в форме" },
      { en: "to be out of shape", ru: "быть не в форме" },
      { en: "sedentary lifestyle", ru: "сидячий образ жизни" },
      { en: "active lifestyle", ru: "активный образ жизни" },
      { en: "to lead a healthy life", ru: "вести здоровый образ жизни" },
      { en: "balanced diet", ru: "сбалансированное питание" },
      { en: "to cut down on", ru: "сокращать (потребление)" },
      { en: "to give up", ru: "бросать (привычку)" },
      { en: "to put on weight", ru: "набирать вес" },
      { en: "to lose weight", ru: "худеть" },
      { en: "to watch one's diet", ru: "следить за питанием" },
      { en: "junk food", ru: "вредная еда" },
      { en: "to crave", ru: "сильно хотеть (еды)" },
      { en: "to overeat", ru: "переедать" },
      { en: "portion", ru: "порция" },
      { en: "nutritious", ru: "питательный" },
      { en: "to skip a meal", ru: "пропускать приём пищи" },
      { en: "to stay hydrated", ru: "пить достаточно воды" },
      { en: "to get enough sleep", ru: "высыпаться" },
      { en: "sleep deprivation", ru: "недосып" },
      { en: "to feel refreshed", ru: "чувствовать себя отдохнувшим" },
      { en: "to be exhausted", ru: "быть измотанным" },
      { en: "to recharge", ru: "восстанавливать силы" },
      { en: "stress", ru: "стресс" },
      { en: "to relieve stress", ru: "снимать стресс" },
      { en: "to relax", ru: "расслабляться" },
      { en: "wellbeing", ru: "благополучие" },
      { en: "mental health", ru: "психическое здоровье" },
      { en: "to look after oneself", ru: "заботиться о себе" },
      { en: "to come down with", ru: "подхватить (болезнь)" },
      { en: "to catch a cold", ru: "простудиться" },
      { en: "symptom", ru: "симптом" },
      { en: "to recover from", ru: "выздоравливать от" },
      { en: "to be on the mend", ru: "идти на поправку" },
      { en: "immune system", ru: "иммунитет" },
      { en: "to boost immunity", ru: "укреплять иммунитет" },
      { en: "checkup", ru: "медосмотр" },
      { en: "to make an appointment", ru: "записаться на приём" },
      { en: "prescription", ru: "рецепт" },
      { en: "to take up a habit", ru: "завести привычку" },
      { en: "to break a habit", ru: "избавиться от привычки" },
      { en: "addiction", ru: "зависимость" },
      { en: "to be hooked on", ru: "подсесть на" },
      { en: "moderation", ru: "умеренность" },
      { en: "in moderation", ru: "в меру" },
      { en: "to burn calories", ru: "сжигать калории" },
      { en: "posture", ru: "осанка" },
      { en: "fatigue", ru: "усталость / утомление" },
      { en: "to pull a muscle", ru: "потянуть мышцу" },
      { en: "to warm up", ru: "разминаться" },
      { en: "to cool down", ru: "делать заминку" },
      { en: "to feel run down", ru: "чувствовать себя истощённым" },
    ],
    "мнения": [
      { en: "in my opinion", ru: "по моему мнению" },
      { en: "from my point of view", ru: "с моей точки зрения" },
      { en: "as far as I'm concerned", ru: "насколько я могу судить" },
      { en: "it seems to me that", ru: "мне кажется, что" },
      { en: "I'm convinced that", ru: "я убеждён, что" },
      { en: "I'd argue that", ru: "я бы возразил, что" },
      { en: "to be honest", ru: "честно говоря" },
      { en: "personally", ru: "лично я" },
      { en: "the way I see it", ru: "как я это вижу" },
      { en: "I reckon", ru: "я считаю (разг.)" },
      { en: "it goes without saying", ru: "само собой разумеется" },
      { en: "there's no doubt that", ru: "нет сомнений, что" },
      { en: "I strongly believe", ru: "я твёрдо убеждён" },
      { en: "to make a point", ru: "высказать мысль / довод" },
      { en: "to put it simply", ru: "проще говоря" },
      { en: "on the one hand", ru: "с одной стороны" },
      { en: "on the other hand", ru: "с другой стороны" },
      { en: "to weigh up", ru: "взвешивать (за и против)" },
      { en: "pros and cons", ru: "плюсы и минусы" },
      { en: "a compelling argument", ru: "убедительный аргумент" },
      { en: "to back up an argument", ru: "подкреплять довод" },
      { en: "to make a case for", ru: "приводить доводы в пользу" },
      { en: "to play devil's advocate", ru: "выступать оппонентом ради спора" },
      { en: "to have a point", ru: "быть в чём-то правым" },
      { en: "to see your point", ru: "понимать твою мысль" },
      { en: "I see what you mean", ru: "понимаю, о чём ты" },
      { en: "fair enough", ru: "справедливо / резонно" },
      { en: "to some extent", ru: "в какой-то мере" },
      { en: "that depends", ru: "смотря по ситуации" },
      { en: "it's debatable", ru: "это спорно" },
      { en: "I beg to differ", ru: "позволю себе не согласиться" },
      { en: "I'm afraid I disagree", ru: "боюсь, я не согласен" },
      { en: "to be against", ru: "быть против" },
      { en: "to be in favour of", ru: "быть за" },
      { en: "to take a stance", ru: "занять позицию" },
      { en: "to bring up a point", ru: "поднять вопрос" },
      { en: "to get the point across", ru: "донести мысль" },
      { en: "to misunderstand", ru: "неправильно понять" },
      { en: "to clarify", ru: "прояснять" },
      { en: "to sum up", ru: "подводя итог" },
      { en: "to put it another way", ru: "иначе говоря" },
      { en: "to give an example", ru: "привести пример" },
      { en: "for instance", ru: "например" },
      { en: "needless to say", ru: "излишне говорить" },
      { en: "to be biased", ru: "быть предвзятым" },
      { en: "objective", ru: "объективный" },
      { en: "subjective", ru: "субъективный" },
      { en: "to jump to conclusions", ru: "делать поспешные выводы" },
      { en: "to have second thoughts", ru: "засомневаться" },
      { en: "to change one's mind", ru: "передумать" },
      { en: "to stand one's ground", ru: "стоять на своём" },
      { en: "to come to terms with", ru: "смириться с" },
      { en: "controversial", ru: "спорный" },
      { en: "to spark debate", ru: "вызывать споры" },
      { en: "broadly speaking", ru: "в общем говоря" },
      { en: "to bear in mind", ru: "иметь в виду" },
    ],
    "маркетинг": [
      { en: "positioning", ru: "позиционирование" },
      { en: "value proposition", ru: "ценностное предложение" },
      { en: "messaging", ru: "то, как мы говорим о продукте" },
      { en: "brand voice", ru: "голос бренда, тон коммуникации" },
      { en: "tone of voice", ru: "тональность" },
      { en: "go-to-market (GTM)", ru: "план вывода на рынок" },
      { en: "funnel", ru: "воронка" },
      { en: "top of funnel", ru: "верх воронки" },
      { en: "bottom of funnel", ru: "низ воронки, ближе к покупке" },
      { en: "drop-off", ru: "отвал, точка, где люди уходят" },
      { en: "bounce rate", ru: "показатель отказов" },
      { en: "acquisition", ru: "привлечение" },
      { en: "retention", ru: "удержание" },
      { en: "churn", ru: "отток клиентов" },
      { en: "customer acquisition cost (CAC)", ru: "стоимость привлечения клиента" },
      { en: "lifetime value (LTV)", ru: "сколько клиент приносит за всё время" },
      { en: "return on ad spend (ROAS)", ru: "окупаемость рекламных расходов" },
      { en: "attribution", ru: "атрибуция, кому засчитываем результат" },
      { en: "benchmark", ru: "ориентир, с чем сравниваем" },
      { en: "baseline", ru: "базовый уровень до изменений" },
      { en: "uplift", ru: "прирост относительно базы" },
      { en: "A/B test", ru: "A/B-тест" },
      { en: "control group", ru: "контрольная группа" },
      { en: "retargeting", ru: "ретаргетинг" },
      { en: "lookalike audience", ru: "похожая аудитория" },
      { en: "frequency cap", ru: "ограничение частоты показов" },
      { en: "nurture leads", ru: "прогревать лидов" },
      { en: "pipeline", ru: "воронка сделок" },
      { en: "forecast", ru: "прогноз" },
      { en: "scale", ru: "масштабировать" },
      { en: "iterate", ru: "дорабатывать по шагам" },
      { en: "roll out", ru: "раскатывать, выкатывать поэтапно" },
      { en: "ship", ru: "выпустить, выкатить" },
      { en: "ramp up", ru: "наращивать обороты" },
      { en: "pull the plug on smth", ru: "свернуть, отключить" },
      { en: "double down on smth", ru: "вложиться сильнее в то, что работает" },
      { en: "move the needle", ru: "дать заметный результат" },
      { en: "low-hanging fruit", ru: "то, что даёт быстрый эффект малой ценой" },
      { en: "trade-off", ru: "компромисс, чем приходится жертвовать" },
      { en: "rule of thumb", ru: "практическое правило" },
      { en: "ballpark figure", ru: "примерная цифра" },
      { en: "underperform", ru: "не дотягивать до плана" },
      { en: "outperform", ru: "обгонять план" },
      { en: "burn budget", ru: "сжигать бюджет" },
      { en: "own smth", ru: "отвечать за направление" },
      { en: "align on smth", ru: "договориться, синхронизироваться" },
      { en: "push back", ru: "возразить, не согласиться" },
      { en: "loop smb in", ru: "подключить человека к вопросу" },
      { en: "circle back", ru: "вернуться к теме позже" },
      { en: "bandwidth", ru: "свободный ресурс времени и сил" },
      { en: "heads-up", ru: "предупреждение заранее" },
      { en: "takeaway", ru: "главный вывод" },
    ],
  },
};

async function seedSharedLibraryOnce() {
  let addedTopics = 0;
  let addedWords = 0;
  const allLevels = [SEED_SHARED_LIBRARY_A1, SEED_SHARED_LIBRARY_A2, SEED_SHARED_LIBRARY_B1, SEED_SHARED_LIBRARY_B2, SEED_SHARED_LIBRARY_C1];
  for (const level of allLevels) {
    for (const [topic, pairs] of Object.entries(level.topics)) {
      const { added } = await addSharedWords(level.difficulty, topic, pairs);
      if (added > 0) addedTopics += 1;
      addedWords += added;
    }
  }
  return { addedTopics, addedWords };
}

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
    () => [],
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
    () => [],
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
    () => [],
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
  // sendMessage/sendAudio-вызовам автоматически, не только к вопросам.
  if ((method === "sendMessage" || method === "sendAudio") && payload && payload.chat_id != null) {
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
    if ((method === "sendMessage" || method === "sendAudio") && payload && payload.chat_id != null) {
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

// ===================== Режим "Грамматика" =====================
// В отличие от лексики (готовый список слов), упражнения генерируются на
// лету из набора подлежащих и глаголов — вариантов получается очень много,
// так что осмысленно "закончить" этот режим невозможно.
//
// Четыре формата вместо одного общего — каждый целится в конкретную
// типичную ошибку:
//  - tenses: общая тренировка на все времена/утверждение-отрицание сразу
//  - negation: don't / doesn't / didn't — самая частая путаница
//  - tobe: когда нужен to be (am/is/are/was/were), а когда — обычный
//    глагол ("She tired" вместо "She is tired", или наоборot "She is
//    play" вместо "She plays")
//  - v2vs: V2 (прошедшее) vs Vs (3-е лицо наст. времени) — "goes" vs
//    "went", с явным маркером времени (every day / yesterday), чтобы
//    ошибка была видна конкретно

const GRAMMAR_EXERCISE_TYPES = {
  tenses: "🔀 Времена (общее)",
  negation: "❌ Отрицания: don't / doesn't / didn't",
  tobe: "🔵 To be vs. обычный глагол",
  v2vs: "🔁 V2 vs Vs (прошедшее / настоящее)",
  vsV1: "🔤 Vs vs V1 (He/She vs We, только настоящее)",
  psVsPrPs: "🆕 Past Simple vs Present Perfect (для начинающих)",
  collocations: "🤝 give / get / take / have",
  modalMeaning: "🧭 Модальные — по смыслу",
  modalTo: "🔧 Модальные — нужна ли to",
  futureInPast: "⏳ Future in the Past vs Future Simple",
  mix: "🎲 Микс всех форматов",
};
const GRAMMAR_REAL_EXERCISE_TYPES = [
  "tenses",
  "negation",
  "tobe",
  "v2vs",
  "vsV1",
  "psVsPrPs",
  "collocations",
  "modalMeaning",
  "modalTo",
  "futureInPast",
];

const GRAMMAR_VERBS = [
  { base: "go", participle: "gone", past: "went", ru: "идти / ходить", contextEn: "to school", contextRu: "в школу",
    ruInf: "идти", ru3sg: "идёт", ru1pl: "идём", ru3pl: "идут", ruPastM: "шёл", ruPastF: "шла", ruPastPl: "шли" },
  { base: "go", participle: "gone", past: "went", ru: "идти / ходить", contextEn: "to the cinema", contextRu: "в кино",
    ruInf: "идти", ru3sg: "идёт", ru1pl: "идём", ru3pl: "идут", ruPastM: "шёл", ruPastF: "шла", ruPastPl: "шли" },
  { base: "play", participle: "played", past: "played", ru: "играть", contextEn: "football", contextRu: "в футбол",
    ruInf: "играть", ru3sg: "играет", ru1pl: "играем", ru3pl: "играют", ruPastM: "играл", ruPastF: "играла", ruPastPl: "играли" },
  { base: "play", participle: "played", past: "played", ru: "играть", contextEn: "the guitar", contextRu: "на гитаре",
    ruInf: "играть", ru3sg: "играет", ru1pl: "играем", ru3pl: "играют", ruPastM: "играл", ruPastF: "играла", ruPastPl: "играли" },
  { base: "watch", participle: "watched", past: "watched", ru: "смотреть", contextEn: "a film", contextRu: "фильм",
    ruInf: "смотреть", ru3sg: "смотрит", ru1pl: "смотрим", ru3pl: "смотрят", ruPastM: "смотрел", ruPastF: "смотрела", ruPastPl: "смотрели" },
  { base: "work", participle: "worked", past: "worked", ru: "работать", contextEn: "at home", contextRu: "дома",
    ruInf: "работать", ru3sg: "работает", ru1pl: "работаем", ru3pl: "работают", ruPastM: "работал", ruPastF: "работала", ruPastPl: "работали" },
  { base: "study", participle: "studied", past: "studied", ru: "учить", contextEn: "English", contextRu: "английский",
    ruInf: "учить", ru3sg: "учит", ru1pl: "учим", ru3pl: "учат", ruPastM: "учил", ruPastF: "учила", ruPastPl: "учили" },
  { base: "eat", participle: "eaten", past: "ate", ru: "есть (кушать)", contextEn: "breakfast", contextRu: "завтрак",
    ruInf: "есть", ru3sg: "ест", ru1pl: "едим", ru3pl: "едят", ruPastM: "ел", ruPastF: "ела", ruPastPl: "ели" },
  { base: "drink", participle: "drunk", past: "drank", ru: "пить", contextEn: "coffee", contextRu: "кофе",
    ruInf: "пить", ru3sg: "пьёт", ru1pl: "пьём", ru3pl: "пьют", ruPastM: "пил", ruPastF: "пила", ruPastPl: "пили" },
  { base: "read", participle: "read", past: "read", ru: "читать", contextEn: "a book", contextRu: "книгу",
    ruInf: "читать", ru3sg: "читает", ru1pl: "читаем", ru3pl: "читают", ruPastM: "читал", ruPastF: "читала", ruPastPl: "читали" },
  { base: "write", participle: "written", past: "wrote", ru: "писать", contextEn: "a letter", contextRu: "письмо",
    ruInf: "писать", ru3sg: "пишет", ru1pl: "пишем", ru3pl: "пишут", ruPastM: "писал", ruPastF: "писала", ruPastPl: "писали" },
  { base: "speak", participle: "spoken", past: "spoke", ru: "говорить", contextEn: "English", contextRu: "по-английски",
    ruInf: "говорить", ru3sg: "говорит", ru1pl: "говорим", ru3pl: "говорят", ruPastM: "говорил", ruPastF: "говорила", ruPastPl: "говорили" },
  { base: "come", participle: "come", past: "came", ru: "приходить", contextEn: "home late", contextRu: "домой поздно",
    ruInf: "приходить", ru3sg: "приходит", ru1pl: "приходим", ru3pl: "приходят", ruPastM: "приходил", ruPastF: "приходила", ruPastPl: "приходили" },
  { base: "see", participle: "seen", past: "saw", ru: "видеть", contextEn: "my friends", contextRu: "своих друзей",
    ruInf: "видеть", ru3sg: "видит", ru1pl: "видим", ru3pl: "видят", ruPastM: "видел", ruPastF: "видела", ruPastPl: "видели" },
  { base: "make", participle: "made", past: "made", ru: "делать (создавать)", contextEn: "dinner", contextRu: "ужин",
    ruInf: "делать", ru3sg: "делает", ru1pl: "делаем", ru3pl: "делают", ruPastM: "делал", ruPastF: "делала", ruPastPl: "делали" },
  { base: "take", participle: "taken", past: "took", ru: "брать", contextEn: "a taxi", contextRu: "такси",
    ruInf: "брать", ru3sg: "берёт", ru1pl: "берём", ru3pl: "берут", ruPastM: "брал", ruPastF: "брала", ruPastPl: "брали" },
  { base: "do", participle: "done", past: "did", ru: "делать", irregular3rd: "does", contextEn: "my homework", contextRu: "домашнюю работу",
    ruInf: "делать", ru3sg: "делает", ru1pl: "делаем", ru3pl: "делают", ruPastM: "делал", ruPastF: "делала", ruPastPl: "делали" },
  { base: "help", participle: "helped", past: "helped", ru: "помогать", contextEn: "my mother", contextRu: "маме",
    ruInf: "помогать", ru3sg: "помогает", ru1pl: "помогаем", ru3pl: "помогают", ruPastM: "помогал", ruPastF: "помогала", ruPastPl: "помогали" },
  { base: "call", participle: "called", past: "called", ru: "звонить", contextEn: "my friend", contextRu: "другу",
    ruInf: "звонить", ru3sg: "звонит", ru1pl: "звоним", ru3pl: "звонят", ruPastM: "звонил", ruPastF: "звонила", ruPastPl: "звонили" },
  { base: "clean", participle: "cleaned", past: "cleaned", ru: "убирать", contextEn: "the house", contextRu: "дом",
    ruInf: "убирать", ru3sg: "убирает", ru1pl: "убираем", ru3pl: "убирают", ruPastM: "убирал", ruPastF: "убирала", ruPastPl: "убирали" },
];

const GRAMMAR_SUBJECTS = [
  { pron: "I", ru: "я", is3rd: false, poss: "my" },
  { pron: "You", ru: "ты", is3rd: false, poss: "your" },
  { pron: "He", ru: "он", is3rd: true, poss: "his" },
  { pron: "She", ru: "она", is3rd: true, poss: "her" },
  { pron: "We", ru: "мы", is3rd: false, poss: "our" },
  { pron: "They", ru: "они", is3rd: false, poss: "their" },
];

// Только для формата "tenses" (натуральные русские предложения): без "I"/
// "You" — у них в прошедшем времени по-русски нужен род говорящего
// (шёл/шла), а мы его не знаем. He/She однозначны по роду, We/They не
// требуют рода вовсе (мн. число).
const RU_SENTENCE_SUBJECTS = [
  { pron: "He", ru: "он", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "She", ru: "она", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "We", ru: "мы", is3rd: false, poss: "our", gender: null, isPlural: true },
  { pron: "They", ru: "они", is3rd: false, poss: "their", gender: null, isPlural: true },
];

// Явные показатели времени по-русски — делают время однозначным, не
// оставляя простора для "а может, это другое время".
const RU_TIME_MARKERS = {
  present: ["каждый день", "обычно"],
  past: ["вчера", "на прошлой неделе"],
  future: ["завтра", "на следующей неделе"],
};

// Спрягает русский глагол под подлежащее/время/полярность — используется
// только для натуральных предложений в формате "tenses".
function ruConjugate(verb, subject, tense) {
  let form;
  if (tense === "present") {
    form = subject.isPlural ? (subject.pron === "We" ? verb.ru1pl : verb.ru3pl) : verb.ru3sg;
  } else if (tense === "past") {
    form = subject.isPlural ? verb.ruPastPl : subject.gender === "m" ? verb.ruPastM : verb.ruPastF;
  } else {
    const aux = subject.pron === "We" ? "будем" : subject.isPlural ? "будут" : "будет";
    form = `${aux} ${verb.ruInf}`;
  }
  return form;
}

function buildRuSentence(subject, verb, tense, polarity, marker) {
  const verbForm = ruConjugate(verb, subject, tense);
  const negPrefix = polarity === "negative" ? "не " : "";
  const sentence = `${subject.ru} ${negPrefix}${verbForm} ${verb.contextRu} ${marker}`.replace(/\s+/g, " ").trim();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const TENSE_POLARITY_COMBOS = [
  { tense: "present", polarity: "affirmative", label: "Present Simple, утверждение" },
  { tense: "present", polarity: "negative", label: "Present Simple, отрицание" },
  { tense: "past", polarity: "affirmative", label: "Past Simple, утверждение" },
  { tense: "past", polarity: "negative", label: "Past Simple, отрицание" },
  { tense: "future", polarity: "affirmative", label: "Future Simple, утверждение" },
  { tense: "future", polarity: "negative", label: "Future Simple, отрицание" },
];

function thirdPersonForm(verb) {
  if (verb.irregular3rd) return verb.irregular3rd;
  const b = verb.base;
  if (/[sxz]$/.test(b) || /(ch|sh)$/.test(b) || /o$/.test(b)) return b + "es";
  if (/[^aeiou]y$/.test(b)) return b.slice(0, -1) + "ies";
  return b + "s";
}

// Для -ing-дистракторов: отбрасываем немую "e" на конце (write -> writing,
// make -> making), не трогаем случаи вроде "see"/"agree", где "e"
// произносится (двойная "ee").
function ingForm(verb) {
  const b = verb.base;
  if (/[^aeiou]e$/.test(b)) return b.slice(0, -1) + "ing";
  return b + "ing";
}

function conjugate(subject, verb, tense, polarity) {
  const is3rd = subject.is3rd;
  if (tense === "present") {
    if (polarity === "affirmative") return is3rd ? thirdPersonForm(verb) : verb.base;
    return (is3rd ? "doesn't " : "don't ") + verb.base;
  }
  if (tense === "past") {
    if (polarity === "affirmative") return verb.past;
    return "didn't " + verb.base;
  }
  // future
  if (polarity === "affirmative") return "will " + verb.base;
  return "won't " + verb.base;
}

function contextFor(subject, verb) {
  return verb.contextEn.replace(/\bmy\b/, subject.poss);
}

// --- Формат "tenses": общая тренировка на все времена/утверждение-отрицание ---
function buildTensesQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const targetIdx = Math.floor(Math.random() * TENSE_POLARITY_COMBOS.length);
    const target = TENSE_POLARITY_COMBOS[targetIdx];
    const markers = RU_TIME_MARKERS[target.tense];
    const marker = markers[Math.floor(Math.random() * markers.length)];

    const context = contextFor(subject, verb);
    const sentences = TENSE_POLARITY_COMBOS.map((c) => `${subject.pron} ${conjugate(subject, verb, c.tense, c.polarity)} ${context}`);
    const uniqueSentences = new Set(sentences.map((s) => s.toLowerCase()));
    if (uniqueSentences.size !== sentences.length) continue;

    const correctText = sentences[targetIdx];
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const order = shuffle(TENSE_POLARITY_COMBOS.map((_, i) => i));
    const correctPos = order.indexOf(targetIdx);
    const options = order.map((i) => sentences[i]);

    return {
      correctText,
      questionLabel: buildRuSentence(subject, verb, target.tense, target.polarity, marker),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "negation": don't / doesn't / didn't ---
// Даём подлежащее + глагол + время (present/past — future сюда не
// затрагиваем, это отдельная путаница). Варианты — все 3 вспомогательных
// глагола (правильный + 2 неверных), плюс типичные ошибки: забытый
// вспомогательный глагол ("not play" вместо "doesn't play") и правильный
// вспомогательный, но неверная форма смыслового глагола ("doesn't played").
function buildNegationQuestion(forbiddenText) {
  const AUX = { present3rd: "doesn't", presentOther: "don't", past: "didn't" };
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const tense = Math.random() < 0.5 ? "present" : "past";
    if (verb.base.toLowerCase() === verb.past.toLowerCase()) continue; // избегаем "read"-подобных совпадений форм
    const context = contextFor(subject, verb);
    const markers = RU_TIME_MARKERS[tense];
    const marker = markers[Math.floor(Math.random() * markers.length)];

    const correctAux = tense === "present" ? (subject.is3rd ? AUX.present3rd : AUX.presentOther) : AUX.past;
    const otherAuxes = [AUX.present3rd, AUX.presentOther, AUX.past].filter((a) => a !== correctAux);

    const correctText = `${subject.pron} ${correctAux} ${verb.base} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const candidates = [
      correctText,
      `${subject.pron} ${otherAuxes[0]} ${verb.base} ${context}`,
      `${subject.pron} ${otherAuxes[1]} ${verb.base} ${context}`,
      `${subject.pron} not ${verb.base} ${context}`, // забыли вспомогательный глагол
      `${subject.pron} ${correctAux} ${verb.past} ${context}`, // верный aux, неверная форма глагола
      `${subject.pron} ${otherAuxes[0]} ${verb.past} ${context}`,
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== candidates.length) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause = ruConjugate(verb, subject, tense);
    const ruSentence = `${subject.ru} не ${ruClause} ${verb.contextRu} ${marker}`;

    return {
      correctText,
      questionLabel: ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "tobe": to be vs обычный глагол ---
// Половина вопросов — описание состояния/качества (нужен to be: is/am/
// are/was/were), половина — действие (нужен обычный глагол). Среди
// неверных вариантов — как раз путаница между двумя типами конструкций.
const STATE_ADJECTIVES = [
  { adjSg: "tired", adjPl: "tired", nomM: "уставший", nomF: "уставшая", nomPl: "уставшие", instrM: "уставшим", instrF: "уставшей", instrPl: "уставшими" },
  { adjSg: "happy", adjPl: "happy", nomM: "счастливый", nomF: "счастливая", nomPl: "счастливые", instrM: "счастливым", instrF: "счастливой", instrPl: "счастливыми" },
  { adjSg: "hungry", adjPl: "hungry", nomM: "голодный", nomF: "голодная", nomPl: "голодные", instrM: "голодным", instrF: "голодной", instrPl: "голодными" },
  { adjSg: "late", adjPl: "late", nomM: "опаздывающий", nomF: "опаздывающая", nomPl: "опаздывающие", instrM: "опаздывающим", instrF: "опаздывающей", instrPl: "опаздывающими" },
  { adjSg: "busy", adjPl: "busy", nomM: "занятый", nomF: "занятая", nomPl: "занятые", instrM: "занятым", instrF: "занятой", instrPl: "занятыми" },
  { adjSg: "ready", adjPl: "ready", nomM: "готовый", nomF: "готовая", nomPl: "готовые", instrM: "готовым", instrF: "готовой", instrPl: "готовыми" },
  { adjSg: "sad", adjPl: "sad", nomM: "грустный", nomF: "грустная", nomPl: "грустные", instrM: "грустным", instrF: "грустной", instrPl: "грустными" },
  { adjSg: "angry", adjPl: "angry", nomM: "злой", nomF: "злая", nomPl: "злые", instrM: "злым", instrF: "злой", instrPl: "злыми" },
  { adjSg: "at home", adjPl: "at home", nomM: "дома", nomF: "дома", nomPl: "дома", instrM: "дома", instrF: "дома", instrPl: "дома" },
  { adjSg: "at work", adjPl: "at work", nomM: "на работе", nomF: "на работе", nomPl: "на работе", instrM: "на работе", instrF: "на работе", instrPl: "на работе" },
  { adjSg: "a doctor", adjPl: "doctors", nomM: "врач", nomF: "врач", nomPl: "врачи", instrM: "врачом", instrF: "врачом", instrPl: "врачами" },
  { adjSg: "a teacher", adjPl: "teachers", nomM: "учитель", nomF: "учительница", nomPl: "учителя", instrM: "учителем", instrF: "учительницей", instrPl: "учителями" },
];

function stateAdjEn(state, subject) {
  return subject.isPlural ? state.adjPl : state.adjSg;
}

// По-русски "был/была/были + прилагательное/существительное" по норме
// требует творительного падежа ("была учительницей", не "была
// учительница") — именительный годится только для настоящего времени
// (там связки "быть" вообще нет: "она учительница").
function stateAdjRu(state, subject, tense) {
  const forms = tense === "past" ? { m: state.instrM, f: state.instrF, pl: state.instrPl } : { m: state.nomM, f: state.nomF, pl: state.nomPl };
  if (subject.isPlural) return forms.pl;
  return subject.gender === "f" ? forms.f : forms.m;
}

function beForm(subject, tense) {
  if (tense === "present") {
    if (subject.pron === "I") return "am";
    return subject.is3rd ? "is" : "are";
  }
  return subject.is3rd || subject.pron === "I" ? "was" : "were";
}

function buildBeVsVerbQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const tense = Math.random() < 0.5 ? "present" : "past";
    const wantState = Math.random() < 0.5;
    const markers = RU_TIME_MARKERS[tense];
    const marker = markers[Math.floor(Math.random() * markers.length)];

    let correctText;
    let ruSentence;
    let candidates;

    if (wantState) {
      const state = STATE_ADJECTIVES[Math.floor(Math.random() * STATE_ADJECTIVES.length)];
      const be = beForm(subject, tense);
      correctText = `${subject.pron} ${be} ${stateAdjEn(state, subject)}`;
      const beRu = tense === "present" ? (subject.isPlural ? "" : "") : subject.isPlural ? "были" : subject.gender === "f" ? "была" : "был";
      ruSentence = tense === "present" ? `${subject.ru} ${stateAdjRu(state, subject, tense)} ${marker}` : `${subject.ru} ${beRu} ${stateAdjRu(state, subject, tense)} ${marker}`;

      const verb1 = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
      const verb2 = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
      const otherBe = tense === "present" ? beForm(subject, "past") : beForm(subject, "present");
      candidates = [
        correctText,
        `${subject.pron} ${otherBe} ${stateAdjEn(state, subject)}`, // верная конструкция, неверное время
        `${subject.pron} ${conjugate(subject, verb1, tense, "affirmative")} ${stateAdjEn(state, subject)}`, // обычный глагол вместо to be — частая ошибка
        `${subject.pron} ${be} ${conjugate(subject, verb2, tense, "affirmative")}`, // to be + обычный глагол вместе — тоже частая ошибка
        `${subject.pron} ${conjugate(subject, verb1, tense, "negative")} ${stateAdjEn(state, subject)}`,
        `${subject.pron} not ${be} ${stateAdjEn(state, subject)}`, // неверный порядок отрицания
      ];
    } else {
      const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
      const context = contextFor(subject, verb);
      correctText = `${subject.pron} ${conjugate(subject, verb, tense, "affirmative")} ${context}`;
      const ruClause = ruConjugate(verb, subject, tense);
      ruSentence = `${subject.ru} ${ruClause} ${verb.contextRu} ${marker}`;

      const be = beForm(subject, tense);
      const otherBe = tense === "present" ? beForm(subject, "past") : beForm(subject, "present");
      const state = STATE_ADJECTIVES[Math.floor(Math.random() * STATE_ADJECTIVES.length)];
      candidates = [
        correctText,
        `${subject.pron} ${be} ${conjugate(subject, verb, tense, "affirmative")} ${context}`, // лишний to be перед глаголом — частая ошибка
        `${subject.pron} ${be} ${ingForm(verb)} ${context}`, // подмена Present Simple на -ing-форму с to be
        `${subject.pron} ${conjugate(subject, verb, tense === "present" ? "past" : "present", "affirmative")} ${context}`, // не то время
        `${subject.pron} ${be} ${stateAdjEn(state, subject)}`, // to be с прилагательным вместо действия
        `${subject.pron} ${otherBe} ${ingForm(verb)} ${context}`,
      ];
    }

    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== candidates.length) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);
    const questionLabel = ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1);

    return { correctText, questionLabel, options, correctPos };
  }
  return null;
}

// --- Формат "v2vs": V2 (прошедшее) vs Vs (3-е лицо наст. времени) ---
// Только He/She/It — именно тут визуально путаются "-s" и форма
// прошедшего времени. Явный маркер времени (every day / yesterday) прямо
// указывает, какая форма нужна.
const TIME_MARKERS_PRESENT = [
  { en: "every day", ru: "каждый день" },
  { en: "usually", ru: "обычно" },
];
const TIME_MARKERS_PAST = [
  { en: "yesterday", ru: "вчера" },
  { en: "last week", ru: "на прошлой неделе" },
];

function buildV2VsQuestion(forbiddenText) {
  const thirdPersonSubjects = RU_SENTENCE_SUBJECTS.filter((s) => s.is3rd);
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = thirdPersonSubjects[Math.floor(Math.random() * thirdPersonSubjects.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    if (verb.base.toLowerCase() === verb.past.toLowerCase()) continue;
    const context = contextFor(subject, verb);
    const wantPresent = Math.random() < 0.5;
    const marker = wantPresent
      ? TIME_MARKERS_PRESENT[Math.floor(Math.random() * TIME_MARKERS_PRESENT.length)]
      : TIME_MARKERS_PAST[Math.floor(Math.random() * TIME_MARKERS_PAST.length)];

    const vs = thirdPersonForm(verb);
    const v2 = verb.past;
    const correctForm = wantPresent ? vs : v2;
    const correctText = `${subject.pron} ${correctForm} ${context} ${marker.en}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const candidates = [
      correctText,
      `${subject.pron} ${wantPresent ? v2 : vs} ${context} ${marker.en}`, // главная путаница: V2 вместо Vs или наоборот
      `${subject.pron} ${verb.base} ${context} ${marker.en}`, // забыли -s (или использовали базовую форму вместо прошедшего)
      `${subject.pron} ${ingForm(verb)} ${context} ${marker.en}`,
      `${subject.pron} doesn't ${verb.base} ${context} ${marker.en}`,
      `${subject.pron} didn't ${verb.base} ${context} ${marker.en}`,
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== candidates.length) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause = ruConjugate(verb, subject, wantPresent ? "present" : "past");
    const ruSentence = `${subject.ru} ${ruClause} ${verb.contextRu} ${marker.ru}`;

    return {
      correctText,
      questionLabel: ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "vsV1": Vs vs V1, только внутри Present Simple ---
// В отличие от v2vs (там путаница между настоящим и прошедшим), здесь
// сравнение — внутри ОДНОГО времени: нужна ли -s или нет. Специально
// упрощено до минимальной пары подлежащих — He/She (нужна -s) против We
// (нужна голая базовая форма, без -s) — чтобы сфокусироваться именно на
// этом различии, не отвлекаясь на остальные лица.
const VS_V1_SUBJECTS = RU_SENTENCE_SUBJECTS.filter((s) => s.pron === "He" || s.pron === "She" || s.pron === "We");

function buildVsV1Question(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = VS_V1_SUBJECTS[Math.floor(Math.random() * VS_V1_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const context = contextFor(subject, verb);
    const marker = RU_TIME_MARKERS.present[Math.floor(Math.random() * RU_TIME_MARKERS.present.length)];

    const vs = thirdPersonForm(verb);
    const v1 = verb.base;
    const correctForm = subject.is3rd ? vs : v1;
    const correctText = `${subject.pron} ${correctForm} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const wrongForm = subject.is3rd ? v1 : vs; // главная путаница: Vs вместо V1 или наоборот
    const candidates = [
      correctText,
      `${subject.pron} ${wrongForm} ${context}`,
      `${subject.pron} ${verb.past} ${context}`, // прошедшее вместо настоящего
      `${subject.pron} ${ingForm(verb)} ${context}`, // -ing вместо простого настоящего
      `${subject.pron} doesn't ${verb.base} ${context}`,
      `${subject.pron} don't ${verb.base} ${context}`,
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause = ruConjugate(verb, subject, "present");
    const ruSentence = `${subject.ru} ${ruClause} ${verb.contextRu} ${marker}`;

    return {
      correctText,
      questionLabel: ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "psVsPrPs": Past Simple vs Present Perfect (для начинающих) ---
// Самое частое затруднение у русскоговорящих — в русском нет
// грамматической разницы между "я сделал" и "я уже сделал (сделал к
// настоящему моменту)", а в английском это два разных времени. Упрощаем
// правило до уровня новичка: есть конкретное время в прошлом (вчера, два
// дня назад) — Past Simple; есть "уже"/"только что" без конкретного
// времени — Present Perfect (have/has + V3).
const PS_PRPS_MARKERS_PAST = ["вчера", "на прошлой неделе", "два дня назад", "в прошлом году"];
const PS_PRPS_MARKERS_PERFECT = ["уже", "только что"];

function buildPsVsPrPsQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    if (verb.base.toLowerCase() === verb.past.toLowerCase() || verb.past.toLowerCase() === verb.participle.toLowerCase()) continue;
    const context = contextFor(subject, verb);
    const wantPerfect = Math.random() < 0.5;
    const haveForm = subject.is3rd && !subject.isPlural ? "has" : "have";
    const wrongHaveForm = haveForm === "has" ? "have" : "has";

    const correctForm = wantPerfect ? `${haveForm} ${verb.participle}` : verb.past;
    const marker = wantPerfect
      ? PS_PRPS_MARKERS_PERFECT[Math.floor(Math.random() * PS_PRPS_MARKERS_PERFECT.length)]
      : PS_PRPS_MARKERS_PAST[Math.floor(Math.random() * PS_PRPS_MARKERS_PAST.length)];

    const correctText = `${subject.pron} ${correctForm} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const wrongTenseForm = wantPerfect ? verb.past : `${haveForm} ${verb.participle}`; // главная путаница
    const candidates = [
      correctText,
      `${subject.pron} ${wrongTenseForm} ${context}`,
      `${subject.pron} ${haveForm} ${verb.past} ${context}`, // have/has + V2 вместо V3
      `${subject.pron} ${verb.participle} ${context}`, // забыли have/has
      `${subject.pron} ${verb.base} ${context}`, // забыли прошедшее вообще
      `${subject.pron} ${wrongHaveForm} ${verb.participle} ${context}`, // неверное согласование have/has
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause2 = ruConjugate(verb, subject, "past");
    const ruSentence2 = `${subject.ru} ${ruClause2} ${verb.contextRu} ${marker}`;

    return {
      correctText,
      questionLabel: ruSentence2.charAt(0).toUpperCase() + ruSentence2.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "collocations": give / get / take / have ---
// Это не про времена, а про то, какой из четырёх глаголов идёт с
// конкретным выражением (give advice, get married, take a photo, have
// breakfast). Специально отобраны только те сочетания, где среди этих
// четырёх глаголов верен ровно один — без "have a shower vs take a
// shower"-подобной двусмысленности между британским и американским
// вариантами.
const COLLOCATIONS = [
  { verb: "give", obj: "advice", ru: "давать совет" },
  { verb: "give", obj: "a presentation", ru: "делать презентацию" },
  { verb: "give", obj: "a hand", ru: "помочь" },
  { verb: "give", obj: "a call", ru: "позвонить" },
  { verb: "give", obj: "a hug", ru: "обнять" },
  { verb: "give", obj: "an example", ru: "привести пример" },
  { verb: "give", obj: "a speech", ru: "произнести речь" },
  { verb: "give", obj: "permission", ru: "дать разрешение" },
  { verb: "get", obj: "a job", ru: "получить работу" },
  { verb: "get", obj: "married", ru: "жениться / выйти замуж" },
  { verb: "get", obj: "home", ru: "добраться домой" },
  { verb: "get", obj: "ready", ru: "приготовиться" },
  { verb: "get", obj: "an idea", ru: "прийти в голову (об идее)" },
  { verb: "get", obj: "angry", ru: "разозлиться" },
  { verb: "get", obj: "lost", ru: "заблудиться" },
  { verb: "get", obj: "divorced", ru: "развестись" },
  { verb: "take", obj: "a photo", ru: "сделать фото" },
  { verb: "take", obj: "a taxi", ru: "взять такси" },
  { verb: "take", obj: "a break", ru: "сделать перерыв" },
  { verb: "take", obj: "a seat", ru: "сесть, занять место" },
  { verb: "take", obj: "medicine", ru: "принять лекарство" },
  { verb: "take", obj: "a risk", ru: "рискнуть" },
  { verb: "take", obj: "notes", ru: "делать записи" },
  { verb: "take", obj: "an exam", ru: "сдавать экзамен" },
  { verb: "have", obj: "breakfast", ru: "позавтракать" },
  { verb: "have", obj: "a party", ru: "устроить вечеринку" },
  { verb: "have", obj: "a baby", ru: "родить ребёнка" },
  { verb: "have", obj: "a dream", ru: "видеть сон" },
  { verb: "have", obj: "fun", ru: "веселиться" },
  { verb: "have", obj: "a chat", ru: "поболтать" },
  { verb: "have", obj: "an argument", ru: "поспорить" },
  { verb: "have", obj: "a headache", ru: "болеть (о голове)" },
];
const COLLOCATION_VERBS = ["give", "get", "take", "have"];

// --- Форматы "modalMeaning" и "modalTo": модальные глаголы ---
// must / have to / should / ought to / need to / can (+ прошедшее время
// там, где оно у модального глагола вообще есть — must/should/ought to
// своей "простой" формы прошедшего времени в этом же значении не имеют,
// поэтому прошедшее даём только для have to → had to, need to → needed
// to, can → could).
const MODAL_VERBS = [
  { key: "must", base: "must", thirdSg: "must", past: null, needsTo: false },
  { key: "haveTo", base: "have to", thirdSg: "has to", past: "had to", needsTo: true },
  { key: "should", base: "should", thirdSg: "should", past: null, needsTo: false },
  { key: "oughtTo", base: "ought to", thirdSg: "ought to", past: null, needsTo: true },
  { key: "needTo", base: "need to", thirdSg: "needs to", past: "needed to", needsTo: true },
  { key: "can", base: "can", thirdSg: "can", past: "could", needsTo: false },
];

const RU_DATIVE = { I: "мне", You: "тебе", He: "ему", She: "ей", We: "нам", They: "им" };
const RU_NOM = { I: "я", You: "ты", He: "он", She: "она", We: "мы", They: "они" };

// Русские формы "должен" (must — своя убеждённость говорящего) и
// "вынужден" (have to — вынуждают обстоятельства/правила) — НАРОЧНО разные
// глаголы, а не один и тот же "должен" на оба модальных: так путаница
// снимается самим выбором слова, без искусственных пояснений в скобках.
function mustFormRu(subject) {
  if (subject.isPlural) return "должны";
  return subject.gender === "f" ? "должна" : "должен";
}

function haveToFormRu(subject, tense) {
  const form = subject.isPlural ? "вынуждены" : subject.gender === "f" ? "вынуждена" : "вынужден";
  if (tense !== "past") return form;
  const beRu = subject.isPlural ? "были" : subject.gender === "f" ? "была" : "был";
  return `${form} ${beRu}`;
}

// "мочь" спрягается по лицам, а не просто ед./мн. число — "мы можем", но
// "они могут" (раньше тут была ошибка: обеим формам ставилось "могут").
function canFormRu(subject, tense) {
  if (tense === "past") {
    if (subject.isPlural) return "могли";
    return subject.gender === "f" ? "могла" : "мог";
  }
  if (subject.isPlural) return subject.pron === "We" ? "можем" : "могут";
  return "может";
}

function needToRuPrefix(subject, tense) {
  return tense === "past" ? `${RU_DATIVE[subject.pron]} нужно было` : `${RU_DATIVE[subject.pron]} нужно`;
}

function ruModalSentence(subject, modal, verb, tense) {
  let prefix;
  if (modal.key === "must") {
    prefix = `${RU_NOM[subject.pron]} ${mustFormRu(subject)}`;
  } else if (modal.key === "haveTo") {
    prefix = `${RU_NOM[subject.pron]} ${haveToFormRu(subject, tense)}`;
  } else if (modal.key === "can") {
    prefix = `${RU_NOM[subject.pron]} ${canFormRu(subject, tense)}`;
  } else if (modal.key === "should") {
    prefix = `${RU_DATIVE[subject.pron]} следует`;
  } else if (modal.key === "oughtTo") {
    prefix = `${RU_DATIVE[subject.pron]} полагается`;
  } else {
    prefix = needToRuPrefix(subject, tense);
  }
  const sentence = `${prefix} ${verb.ruInf} ${verb.contextRu}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// Формат "по смыслу": даётся ситуация по-русски (с явной подсказкой,
// какой оттенок смысла нужен — иначе "должен" из русского одинаково
// подходит и под must, и под have to), и все 6 модальных глаголов с тем
// же подлежащим и глаголом — как варианты ответа.
function buildModalMeaningQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const targetModal = MODAL_VERBS[Math.floor(Math.random() * MODAL_VERBS.length)];
    const usePast = !!targetModal.past && Math.random() < 0.5;
    const context = contextFor(subject, verb);

    const phraseFor = (modal) => {
      let form;
      if (usePast && modal.past) form = modal.past;
      else form = subject.is3rd && !subject.isPlural ? modal.thirdSg : modal.base;
      return `${subject.pron} ${form} ${verb.base} ${context}`;
    };

    const correctText = phraseFor(targetModal);
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const candidates = MODAL_VERBS.map(phraseFor);
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== candidates.length) continue;

    const targetIdx = MODAL_VERBS.indexOf(targetModal);
    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(targetIdx);
    const options = order.map((i) => candidates[i]);

    return {
      correctText,
      questionLabel: ruModalSentence(subject, targetModal, verb, usePast ? "past" : "present"),
      options,
      correctPos,
    };
  }
  return null;
}

// Формат "нужна ли to": фиксируем модальный глагол и глагол действия,
// главный дистрактор — та же форма модального глагола, но с "to", где
// его быть не должно (must to go), или без "to", где оно обязательно
// (has go вместо has to go). Плюс формы других модальных глаголов для
// разнообразия.
function buildModalToQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const modal = MODAL_VERBS[Math.floor(Math.random() * MODAL_VERBS.length)];
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const context = contextFor(subject, verb);
    const usePast = !!modal.past && Math.random() < 0.5;

    const modalForm = usePast ? modal.past : subject.is3rd ? modal.thirdSg : modal.base;
    const correctText = `${subject.pron} ${modalForm} ${verb.base} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const toggledForm = modal.needsTo ? modalForm.replace(/\s*to$/, "").trim() : `${modalForm} to`;
    const toggledText = `${subject.pron} ${toggledForm} ${verb.base} ${context}`;

    const otherModals = shuffle(MODAL_VERBS.filter((m) => m.key !== modal.key)).slice(0, 4);
    const otherTexts = otherModals.map((m) => {
      const f = subject.is3rd ? m.thirdSg : m.base;
      return `${subject.pron} ${f} ${verb.base} ${context}`;
    });

    const candidates = [correctText, toggledText, ...otherTexts];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    return {
      correctText,
      questionLabel: ruModalSentence(subject, modal, verb, usePast ? "past" : "present"),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "futureInPast": Future in the Past vs Future Simple ---
// Ключевое отличие — от какого момента "будущее": если рамка (думает/
// говорит/уверен...) в настоящем времени, это обычное будущее (will);
// если рамка сама в прошедшем (думал/сказал/была уверена...), то это
// будущее-в-прошедшем (would) — классический разбор косвенной речи.
// Русское предложение внутри "что..." по-русски звучит одинаково в обоих
// случаях (будущее время глагола не меняется от контекста рамки) — именно
// поэтому по-русски это не путается, а в английском нужно верно выбрать
// will или would, ориентируясь на время самой рамки.
const FUTURE_IN_PAST_FRAMES = [
  { ru: "Он думает, что", useWould: false },
  { ru: "Он думал, что", useWould: true },
  { ru: "Она говорит, что", useWould: false },
  { ru: "Она сказала, что", useWould: true },
  { ru: "Они уверены, что", useWould: false },
  { ru: "Они были уверены, что", useWould: true },
  { ru: "Мы знаем, что", useWould: false },
  { ru: "Мы знали, что", useWould: true },
];

function buildFutureInPastQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const frame = FUTURE_IN_PAST_FRAMES[Math.floor(Math.random() * FUTURE_IN_PAST_FRAMES.length)];
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const context = contextFor(subject, verb);

    const correctModal = frame.useWould ? "would" : "will";
    const correctText = `${subject.pron} ${correctModal} ${verb.base} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const wrongModal = frame.useWould ? "will" : "would";
    const candidates = [
      correctText,
      `${subject.pron} ${wrongModal} ${verb.base} ${context}`, // главная путаница: will vs would
      `${subject.pron} ${correctModal} ${verb.past} ${context}`, // верный модальный, но неверная форма глагола
      `${subject.pron} ${verb.base} ${context}`, // модальный вообще пропущен
      `${subject.pron} ${verb.past} ${context}`, // тоже пропущен, но со "случайным" прошедшим
      `${subject.pron} ${wrongModal} ${verb.past} ${context}`, // и то, и другое неверно
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause = ruConjugate(verb, subject, "future");
    const ruSentence = `${frame.ru} ${subject.ru} ${ruClause} ${verb.contextRu}`;

    return {
      correctText,
      questionLabel: ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

function buildCollocationQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const item = COLLOCATIONS[Math.floor(Math.random() * COLLOCATIONS.length)];
    const correctText = `${item.verb} ${item.obj}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const options = shuffle(COLLOCATION_VERBS.map((v) => `${v} ${item.obj}`));
    const correctPos = options.indexOf(correctText);

    return {
      correctText,
      questionLabel: `«${item.ru}» — какой глагол?`,
      options,
      correctPos,
    };
  }
  return null;
}

function buildGrammarQuestion(forbiddenText, exerciseType) {
  const requestedType = exerciseType || "tenses";
  for (let attempt = 0; attempt < 5; attempt++) {
    const type = requestedType === "mix" ? GRAMMAR_REAL_EXERCISE_TYPES[Math.floor(Math.random() * GRAMMAR_REAL_EXERCISE_TYPES.length)] : requestedType;
    let q;
    if (type === "negation") q = buildNegationQuestion(forbiddenText);
    else if (type === "tobe") q = buildBeVsVerbQuestion(forbiddenText);
    else if (type === "v2vs") q = buildV2VsQuestion(forbiddenText);
    else if (type === "vsV1") q = buildVsV1Question(forbiddenText);
    else if (type === "psVsPrPs") q = buildPsVsPrPsQuestion(forbiddenText);
    else if (type === "collocations") q = buildCollocationQuestion(forbiddenText);
    else if (type === "modalMeaning") q = buildModalMeaningQuestion(forbiddenText);
    else if (type === "modalTo") q = buildModalToQuestion(forbiddenText);
    else if (type === "futureInPast") q = buildFutureInPastQuestion(forbiddenText);
    else q = buildTensesQuestion(forbiddenText);
    if (q) return q;
  }
  return null;
}

function buildGrammarPicked(prefix, forbiddenText, exerciseType) {
  const q = buildGrammarQuestion(forbiddenText, exerciseType);
  const keyboard = q.options.map((textOpt, i) => [{ text: textOpt, callback_data: `a:${i}` }]);
  const questionText = `🎯 ${mdEscape(q.questionLabel)}\nВыбери верную форму:`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;
  return {
    correct: { en: q.correctText, ru: q.questionLabel },
    correctPos: q.correctPos,
    keyboard,
    text,
    mode: "grammar",
    exerciseType: exerciseType || "tenses",
  };
}
// =================== Конец режима "Грамматика" ===================

// ================ Режим "Неправильные глаголы" ================
// Показывает базовую форму глагола, просит выбрать верную пару
// Past Simple — Past Participle из 6 вариантов (сама верная пара + пары от
// 5 других случайных неправильных глаголов — это как раз и тренирует
// запоминание, какая форма к какому глаголу относится).

const IRREGULAR_VERBS = [
  // A1-A2 — самые базовые, встречаются с первых уроков
  { base: "go", past: "went", participle: "gone", ru: "идти / ходить", level: "a" },
  { base: "have", past: "had", participle: "had", ru: "иметь", level: "a" },
  { base: "do", past: "did", participle: "done", ru: "делать", level: "a" },
  { base: "see", past: "saw", participle: "seen", ru: "видеть", level: "a" },
  { base: "come", past: "came", participle: "come", ru: "приходить", level: "a" },
  { base: "take", past: "took", participle: "taken", ru: "брать", level: "a" },
  { base: "make", past: "made", participle: "made", ru: "делать (создавать)", level: "a" },
  { base: "know", past: "knew", participle: "known", ru: "знать", level: "a" },
  { base: "get", past: "got", participle: "gotten", ru: "получать", level: "a" },
  { base: "give", past: "gave", participle: "given", ru: "давать", level: "a" },
  { base: "eat", past: "ate", participle: "eaten", ru: "есть (кушать)", level: "a" },
  { base: "drink", past: "drank", participle: "drunk", ru: "пить", level: "a" },
  { base: "write", past: "wrote", participle: "written", ru: "писать", level: "a" },
  { base: "read", past: "read", participle: "read", ru: "читать", level: "a" },
  { base: "buy", past: "bought", participle: "bought", ru: "покупать", level: "a" },
  { base: "run", past: "ran", participle: "run", ru: "бегать", level: "a" },
  { base: "sit", past: "sat", participle: "sat", ru: "сидеть", level: "a" },
  // B1-B2 — средний уровень
  { base: "stand", past: "stood", participle: "stood", ru: "стоять", level: "b" },
  { base: "find", past: "found", participle: "found", ru: "находить", level: "b" },
  { base: "think", past: "thought", participle: "thought", ru: "думать", level: "b" },
  { base: "tell", past: "told", participle: "told", ru: "говорить (рассказывать)", level: "b" },
  { base: "feel", past: "felt", participle: "felt", ru: "чувствовать", level: "b" },
  { base: "leave", past: "left", participle: "left", ru: "уходить / оставлять", level: "b" },
  { base: "speak", past: "spoke", participle: "spoken", ru: "говорить", level: "b" },
  { base: "meet", past: "met", participle: "met", ru: "встречать", level: "b" },
  { base: "win", past: "won", participle: "won", ru: "выигрывать", level: "b" },
  { base: "pay", past: "paid", participle: "paid", ru: "платить", level: "b" },
  { base: "wear", past: "wore", participle: "worn", ru: "носить (одежду)", level: "b" },
  { base: "hold", past: "held", participle: "held", ru: "держать", level: "b" },
  { base: "sing", past: "sang", participle: "sung", ru: "петь", level: "b" },
  { base: "become", past: "became", participle: "become", ru: "становиться", level: "b" },
  { base: "understand", past: "understood", participle: "understood", ru: "понимать", level: "b" },
  { base: "lose", past: "lost", participle: "lost", ru: "терять", level: "b" },
  { base: "begin", past: "began", participle: "begun", ru: "начинать", level: "b" },
  // B2+ — более редкие/продвинутые
  { base: "forget", past: "forgot", participle: "forgotten", ru: "забывать", level: "c" },
  { base: "bring", past: "brought", participle: "brought", ru: "приносить", level: "c" },
  { base: "choose", past: "chose", participle: "chosen", ru: "выбирать", level: "c" },
  { base: "sell", past: "sold", participle: "sold", ru: "продавать", level: "c" },
  { base: "send", past: "sent", participle: "sent", ru: "отправлять", level: "c" },
  { base: "build", past: "built", participle: "built", ru: "строить", level: "c" },
  { base: "grow", past: "grew", participle: "grown", ru: "расти", level: "c" },
  { base: "draw", past: "drew", participle: "drawn", ru: "рисовать", level: "c" },
  { base: "drive", past: "drove", participle: "driven", ru: "водить (машину)", level: "c" },
  { base: "ride", past: "rode", participle: "ridden", ru: "ездить верхом", level: "c" },
  { base: "fly", past: "flew", participle: "flown", ru: "летать", level: "c" },
  { base: "teach", past: "taught", participle: "taught", ru: "учить (преподавать)", level: "c" },
  { base: "fight", past: "fought", participle: "fought", ru: "драться / бороться", level: "c" },
  { base: "catch", past: "caught", participle: "caught", ru: "ловить", level: "c" },
  { base: "throw", past: "threw", participle: "thrown", ru: "бросать", level: "c" },
  { base: "break", past: "broke", participle: "broken", ru: "ломать", level: "c" },
];

const IRREGULAR_LEVEL_LABELS = { a: "A1–A2", b: "B1–B2", c: "B2+" };

const IRREGULAR_EXERCISE_TYPES = {
  triplet: "🔺 Все 3 формы",
  pastonly: "① Только Past Simple",
  particonly: "② Только Past Participle",
  ru2en: "🇷🇺→🇬🇧 Перевод → глагол",
  form2base: "🔍 Угадай глагол по форме",
  mix: "🎲 Микс всех форматов",
};

// "Настоящие" форматы, из которых Микс выбирает случайный на каждый вопрос
// (сам "mix" не формат вопроса, а режим выбора формата).
const IRREGULAR_REAL_EXERCISE_TYPES = ["triplet", "pastonly", "particonly", "ru2en", "form2base"];

// Возвращает count случайных индексов из pool, отличных от excludeIdx и
// друг от друга (и от alsoExclude, если передан).
function pickOtherIndices(pool, excludeIdx, count, alsoExclude) {
  const excluded = new Set([excludeIdx, ...((alsoExclude && alsoExclude) || [])]);
  const result = [];
  let guard = 0;
  while (result.length < count && guard < 500) {
    guard++;
    const j = Math.floor(Math.random() * pool.length);
    if (excluded.has(j) || result.includes(j)) continue;
    result.push(j);
  }
  return result;
}

// Пять РАЗНЫХ по формату упражнений на неправильные глаголы:
//  - triplet: даём перевод, просим узнать/вспомнить все 3 формы целиком
//    (самый полный и самый сложный формат)
//  - pastonly / particonly: только ОДНА конкретная форма — но среди
//    вариантов специально есть "ловушка": форма-двойник ЭТОГО ЖЕ глагола
//    (например, при вопросе про Past Simple один из неверных вариантов —
//    Past Participle этого самого глагола), чтобы нельзя было угадать
//    просто по знакомому виду слова
//  - ru2en: только перевод, без английской подсказки вообще — просит
//    вспомнить сам базовый глагол по-английски
//  - form2base: показывает готовую форму (Past Simple ИЛИ Participle,
//    без подписи какая) и просит определить, от какого глагола она —
//    тренирует узнавание "в тексте", а не заучивание таблицы
function buildIrregularQuestion(forbiddenText, level, exerciseType) {
  const pool = level ? IRREGULAR_VERBS.filter((v) => v.level === level) : IRREGULAR_VERBS;
  const requestedType = exerciseType || "triplet";

  for (let attempt = 0; attempt < 25; attempt++) {
    // При "mix" на КАЖДУЮ попытку берём случайный настоящий формат — так
    // разнообразие сохраняется, даже если конкретная попытка не удалась и
    // потребовался повтор цикла.
    const type =
      requestedType === "mix" ? IRREGULAR_REAL_EXERCISE_TYPES[Math.floor(Math.random() * IRREGULAR_REAL_EXERCISE_TYPES.length)] : requestedType;
    const idx = Math.floor(Math.random() * pool.length);
    const verb = pool[idx];
    const samePastAndParticiple = verb.past.toLowerCase() === verb.participle.toLowerCase();

    let correctText;
    let questionLabel;
    let distractorTexts;

    if (type === "pastonly") {
      correctText = verb.past;
      questionLabel = `${verb.base.toUpperCase()} (${verb.ru}) — Past Simple?`;
      const others = pickOtherIndices(pool, idx, samePastAndParticiple ? 5 : 4);
      distractorTexts = others.map((j) => pool[j].past);
      if (!samePastAndParticiple) distractorTexts.push(verb.participle); // ловушка: спутать с Participle
    } else if (type === "particonly") {
      correctText = verb.participle;
      questionLabel = `${verb.base.toUpperCase()} (${verb.ru}) — Past Participle?`;
      const others = pickOtherIndices(pool, idx, samePastAndParticiple ? 5 : 4);
      distractorTexts = others.map((j) => pool[j].participle);
      if (!samePastAndParticiple) distractorTexts.push(verb.past); // ловушка: спутать с Past Simple
    } else if (type === "ru2en") {
      correctText = verb.base;
      questionLabel = `Как будет по-английски: «${verb.ru}»?`;
      const others = pickOtherIndices(pool, idx, 5);
      distractorTexts = others.map((j) => pool[j].base);
    } else if (type === "form2base") {
      const useParticiple = !samePastAndParticiple && Math.random() < 0.5;
      const shownForm = useParticiple ? verb.participle : verb.past;
      correctText = verb.base;
      questionLabel = `Какой это глагол — «${shownForm}»?`;
      const others = pickOtherIndices(pool, idx, 5);
      distractorTexts = others.map((j) => pool[j].base);
    } else {
      // triplet
      correctText = `${verb.base} - ${verb.past} - ${verb.participle}`;
      questionLabel = `Вспомни все 3 формы: «${verb.ru}»`;
      const others = pickOtherIndices(pool, idx, 5);
      distractorTexts = others.map((j) => `${pool[j].base} - ${pool[j].past} - ${pool[j].participle}`);
    }

    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const allOptions = [correctText, ...distractorTexts];
    const uniqueOptions = new Set(allOptions.map((o) => o.toLowerCase()));
    if (uniqueOptions.size !== allOptions.length) continue; // редкое совпадение форм — пробуем другой набор

    const order = shuffle(allOptions.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => allOptions[i]);

    return { correctText, questionLabel, options, correctPos };
  }
  return null; // практически недостижимо при таком размере списка
}

function buildIrregularPicked(prefix, forbiddenText, level, exerciseType) {
  const q = buildIrregularQuestion(forbiddenText, level, exerciseType);
  const keyboard = q.options.map((textOpt, i) => [{ text: textOpt, callback_data: `a:${i}` }]);
  const levelLabel = level ? ` [${IRREGULAR_LEVEL_LABELS[level] || level}]` : "";
  const questionText = `🎯${levelLabel} ${mdEscape(q.questionLabel)}`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;
  return {
    correct: { en: q.correctText, ru: q.questionLabel },
    correctPos: q.correctPos,
    keyboard,
    text,
    mode: "irregular",
    level,
    exerciseType: exerciseType || "triplet",
  };
}
// ============== Конец режима "Неправильные глаголы" ==============

// Подбирает несколько неверных вариантов, у которых и перевод, и слово
// отличаются от правильного и друг от друга (чтобы не было двух одинаковых кнопок).
// Грубое определение "это глагол или нет" — точного разбора частей речи у
// нас нет (слова добавляются свободным текстом), так что ориентируемся на
// приметы: тире в форме глагола ("Write - wrote - written", "Make - made"),
// явный английский инфинитив ("to run"), или характерное для русского
// инфинитива окончание перевода (-ть/-ти/-чь — играть, идти, мочь).
function looksLikeVerb(word) {
  const en = (word.en || "").trim();
  if (/^\S.*\s-\s\S/.test(en)) return true; // "Write - wrote - written", "Make - made"
  if (/^to\s+\S/i.test(en)) return true; // "to run"
  const ruFirstWord = (word.ru || "")
    .trim()
    .toLowerCase()
    .split(/[\s,/(]/)[0];
  return /(ть|ти|чь)$/.test(ruFirstWord);
}

// Подбирает неверные варианты — по возможности той же "части речи" (если
// правильный ответ похож на глагол, стараемся давать в качестве
// дистракторов тоже глаголы, а не вперемешку с существительными и
// прилагательными — иначе можно угадать правильный ответ просто по виду
// слова, не зная перевода). Если в словаре не хватает слов той же
// категории — достаём недостающие дистракторы из остальных слов, чтобы
// вариантов всегда было ровно нужное количество.
function pickDistractors(vocab, correctWord, count) {
  const usedRu = new Set([correctWord.ru.toLowerCase().trim()]);
  const usedEn = new Set([correctWord.en.toLowerCase().trim()]);
  const chosen = [];

  const wantVerb = looksLikeVerb(correctWord);
  const pool = vocab.filter((w) => {
    const ru = w.ru.toLowerCase().trim();
    const en = w.en.toLowerCase().trim();
    return !usedEn.has(en) && !usedRu.has(ru);
  });
  const samePos = pool.filter((w) => looksLikeVerb(w) === wantVerb);
  const otherPos = pool.filter((w) => looksLikeVerb(w) !== wantVerb);

  function pickFrom(list) {
    let attempts = 0;
    while (chosen.length < count && list.length && attempts < 300) {
      attempts++;
      const w = list[Math.floor(Math.random() * list.length)];
      const ru = w.ru.toLowerCase().trim();
      const en = w.en.toLowerCase().trim();
      if (usedEn.has(en) || usedRu.has(ru)) continue;
      usedRu.add(ru);
      usedEn.add(en);
      chosen.push(w);
    }
  }

  pickFrom(samePos);
  if (chosen.length < count) pickFrom(otherPos); // не хватает своей категории — добираем остальными

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
    seenEn: picked.newSeenEn || [],
    recentTail: picked.newTail || [],
    mode: picked.mode || "vocab",
    level: picked.level || null,
    exerciseType: picked.exerciseType || null,
    topic: picked.topic !== undefined ? picked.topic : null,
    shared: picked.shared !== undefined ? picked.shared : null,
  });
}

// Одиночная отправка вопроса (без одновременного обновления счёта) — для
// /start и /play. Историю берём из предыдущего pending, если он есть
// (надёжно, без похода в общее хранилище счёта).
// Слово без темы попадает в условную "общую" корзину. null/undefined в
// качестве topic означает "все темы вместе", без фильтрации.
const GENERAL_TOPIC = "__general__";

function getDistinctTopics(vocab) {
  return [...new Set(vocab.map((w) => w.topic || GENERAL_TOPIC))];
}

function filterByTopic(vocab, topic) {
  if (!topic) return vocab;
  if (topic === GENERAL_TOPIC) return vocab.filter((w) => !w.topic);
  return vocab.filter((w) => w.topic === topic);
}

function topicLabel(topic) {
  if (!topic || topic === GENERAL_TOPIC) return "Общие слова";
  return topic;
}

async function sendQuestion(chatId, stats, prefix, modeOverride, levelOverride, exerciseTypeOverride, topicOverride, sharedOverride) {
  const prevPending = await pendingStore().get(String(chatId), { type: "json" });
  const currentMode = prevPending && prevPending.mode ? prevPending.mode : "vocab";
  const mode = modeOverride || currentMode;

  if (mode === "grammar") {
    const exerciseType = exerciseTypeOverride || (prevPending && prevPending.mode === "grammar" && prevPending.exerciseType) || "tenses";
    const picked = buildGrammarPicked(prefix, null, exerciseType);
    await deliverQuestion(chatId, picked);
    return;
  }

  if (mode === "irregular") {
    const level = levelOverride || (prevPending && prevPending.level) || "a";
    const exerciseType = exerciseTypeOverride || (prevPending && prevPending.exerciseType) || "triplet";
    const picked = buildIrregularPicked(prefix, null, level, exerciseType);
    await deliverQuestion(chatId, picked);
    return;
  }

  const shared = sharedOverride !== undefined ? sharedOverride : (prevPending && prevPending.shared) || null;

  let fullVocab;
  let vocab;
  let topic;
  if (shared) {
    fullVocab = await getSharedVocab(shared.difficulty, shared.topic);
    vocab = fullVocab;
    topic = null;
  } else {
    fullVocab = await getVocab(chatId);
    topic = topicOverride !== undefined ? topicOverride : prevPending && prevPending.topic ? prevPending.topic : null;
    vocab = filterByTopic(fullVocab, topic);
  }

  if (!vocab.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: shared
        ? "В этой теме общей библиотеки пока нет слов."
        : fullVocab.length
        ? `В теме «${topicLabel(topic)}» пока нет слов.`
        : "Словарь сейчас пуст. Вставь сюда слова в формате «English . перевод», и я начну спрашивать.",
    });
    return;
  }

  const seenEnList = prevPending && Array.isArray(prevPending.seenEn) ? prevPending.seenEn : [];
  const recentTailList = prevPending && Array.isArray(prevPending.recentTail) ? prevPending.recentTail : [];

  const picked = buildQuestion(vocab, stats.wrong, prefix, null, seenEnList, recentTailList);
  picked.topic = topic;
  picked.shared = shared;
  await deliverQuestion(chatId, picked);
}

function statsLine(practicedCount, totalCount) {
  return `📚 ${practicedCount}/${totalCount} слов отработано`;
}

// Постоянное меню снизу экрана (не привязано к конкретному сообщению, как
// inline-кнопки, а всегда под рукой). Кнопки просто отправляют свой текст
// как обычное сообщение — дальше это обрабатывается как любая команда.
const BTN_VOCAB = "📚 Лексика";
const BTN_IRREGULAR = "🔄 Неправильные глаголы";
const BTN_GRAMMAR = "📝 Грамматика";
const BTN_HIDE = "🔽 Скрыть меню";

async function mainReplyKeyboard(chatId) {
  const admin = await isAdmin(chatId);
  const rows = [
    [BTN_VOCAB, BTN_IRREGULAR, BTN_GRAMMAR],
    ["/start", BTN_HIDE],
  ];
  if (admin) rows.push(["/students"]);
  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function handleStart(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "Привет! Это тренажёр 🎓\n\n" +
      "Показываю слово, фразу или упражнение — выбираешь верный вариант из вариантов. " +
      "То, в чём ошибаешься, будет попадаться чаще.\n\n" +
      "Чтобы добавить новые слова — просто вставь сюда строки вида «English . перевод» " +
      "(можно сразу много строк за раз), я сама их разберу.\n\n" +
      "Команды: /mode, /play, /score, /count, /delete <слово>, /reset, /help",
    reply_markup: await mainReplyKeyboard(chatId),
  });
  await handleMode(chatId);
}

// Показывает выбор режима тренировки — кнопками, а не текстом, чтобы не
// нужно было ничего печатать.
async function handleModeVocabPersonal(chatId) {
  const vocab = await getVocab(chatId);
  const topics = getDistinctTopics(vocab);
  if (topics.length <= 1) {
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, "📚 Режим: Лексика", "vocab", undefined, undefined, null, null);
    return;
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: "По какой теме?",
    reply_markup: {
      inline_keyboard: [
        ...topics.map((t, i) => [{ text: `📌 ${topicLabel(t)}`, callback_data: `vtopic:${i}` }]),
        [{ text: "🔀 Все темы вместе", callback_data: "vtopic:all" }],
      ],
    },
  });
}

async function handleModeVocab(chatId) {
  // Блок "Общая библиотека" показываем только если в ней вообще что-то
  // есть — иначе для учеников, у которых Маргарита её ещё не наполнила,
  // ничего не меняется вообще, никакого лишнего выбора.
  const sharedEntries = await listSharedLibrary();
  if (!sharedEntries.length) {
    await handleModeVocabPersonal(chatId);
    return;
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Лексика — откуда слова?",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📓 Мой словарь", callback_data: "vsource:personal" }],
        [{ text: "📖 Общая библиотека", callback_data: "vsource:shared" }],
      ],
    },
  });
}

async function handleModeGrammar(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Грамматика — какой формат?",
    reply_markup: {
      inline_keyboard: Object.entries(GRAMMAR_EXERCISE_TYPES).map(([key, label]) => [{ text: label, callback_data: `gtype:${key}` }]),
    },
  });
}

async function handleModeIrregular(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Неправильные глаголы — какой уровень?",
    reply_markup: {
      inline_keyboard: [
        [{ text: "A1–A2", callback_data: "ilevel:a" }],
        [{ text: "B1–B2", callback_data: "ilevel:b" }],
        [{ text: "B2+", callback_data: "ilevel:c" }],
      ],
    },
  });
}

async function handleMode(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Что тренируем?",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📚 Лексика", callback_data: "mode:vocab" }],
        [{ text: "📝 Грамматика (времена)", callback_data: "mode:grammar" }],
        [{ text: "🔄 Неправильные глаголы", callback_data: "mode:irregular" }],
      ],
    },
  });
}

async function handleHelp(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "/mode — переключить лексика / грамматика\n" +
      "/play — новый вопрос\n" +
      "/score — статистика\n" +
      "/count — сколько слов в словаре\n" +
      "/delete <English> — удалить слово (можно сразу список, по одному на строку)\n" +
      "/reset — сбросить прогресс\n" +
      "/hidemenu (или кнопка «🔽 Скрыть меню») — убрать нижнее меню (если на телефоне не видно переписку)\n" +
      "/showmenu — вернуть его обратно\n\n" +
      "Чтобы добавить слова — просто пришли строки вида «English . перевод», " +
      "хоть одну, хоть весь список с урока сразу.",
    reply_markup: await mainReplyKeyboard(chatId),
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
    reply_markup: await mainReplyKeyboard(chatId),
  });
}

async function handleReset(chatId) {
  await withOptimisticUpdate(statsStore(), String(chatId), emptyStats, () => emptyStats());
  await tg("sendMessage", { chat_id: chatId, text: "Прогресс сброшен. /play — начать заново.", reply_markup: await mainReplyKeyboard(chatId) });
}

async function handleCount(chatId) {
  const vocab = await getVocab(chatId);
  await tg("sendMessage", { chat_id: chatId, text: `В словаре сейчас ${vocab.length} слов.`, reply_markup: await mainReplyKeyboard(chatId) });
}

// Убрать/вернуть нижнее меню — на маленьких экранах оно занимает много
// места и заслоняет переписку, поэтому можно временно спрятать.
async function handleHideMenu(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Меню внизу скрыто. Все команды по-прежнему работают, если написать их текстом (/mode, /help и т.д.). Вернуть меню — /showmenu.",
    reply_markup: { remove_keyboard: true },
  });
}

async function handleShowMenu(chatId) {
  await tg("sendMessage", { chat_id: chatId, text: "Меню снова внизу.", reply_markup: await mainReplyKeyboard(chatId) });
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

// Только для админов: убирает у КОНКРЕТНОГО другого чата именно слова из
// старого стартового списка (data/vocab.mjs, 379 слов) — на случай, если
// человек успел зарегистрироваться до того, как автозаполнение убрали.
// Всё, что человек добавил сам сверх этого списка, остаётся нетронутым.
async function handleRemoveDefault(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const targetRaw = argText.trim();
  if (!targetRaw) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /removedefault @username или chat_id" });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }

  const defaultEnSet = new Set(DEFAULT_VOCAB.map((w) => w.en.toLowerCase()));
  let removed = 0;
  let total = 0;
  await withOptimisticUpdate(wordsStore(), `words:${targetId}`, () => [], (vocab) => {
    const before = vocab.length;
    const next = vocab.filter((w) => !defaultEnSet.has(w.en.toLowerCase()));
    removed = before - next.length;
    total = next.length;
    return next;
  });
  await tg("sendMessage", {
    chat_id: chatId,
    text: `Готово — убрала у ${targetRaw} ${removed} слов из старого стартового списка. Осталось (добавлено самим человеком): ${total}.`,
  });
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
  const firstLine = (lines[0] || "").trim();
  if (!firstLine) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/addto @username (или chat_id) [#тема]\nEnglish . перевод\n... (можно много строк)",
    });
    return;
  }
  // Первая строка — получатель, и через пробел — необязательная тема
  // (#медицина), которой будут помечены все добавляемые этим вызовом слова.
  const firstLineParts = firstLine.split(/\s+/);
  const targetRaw = firstLineParts[0];
  const topicRaw = firstLineParts.slice(1).join(" ").replace(/^#/, "").trim();
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }

  const pairs = [];
  for (const line of lines.slice(1)) {
    const parsed = parseVocabLine(line);
    if (parsed) {
      if (topicRaw) parsed.topic = topicRaw;
      pairs.push(parsed);
    }
  }
  if (!pairs.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одной пары «слово - перевод» после первой строки." });
    return;
  }

  const { added, total } = await addWords(targetId, pairs);
  const skippedDupes = pairs.length - added;
  let msg = `✅ Добавлено в словарь ${targetRaw}: ${added}. Всего у него в словаре: ${total}.`;
  if (topicRaw) msg += `\nТема: ${topicRaw}.`;
  if (skippedDupes) msg += `\nПропущено как дубли: ${skippedDupes}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

// Только для админов: помечает темой УЖЕ СУЩЕСТВУЮЩИЕ слова в чьём-то
// словаре (по точному совпадению английского термина) — чтобы можно было
// разложить по темам то, что уже добавлено, без пересоздания слов заново.
async function handleSetTopic(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText.split(/\r?\n/);
  const firstLine = (lines[0] || "").trim();
  const firstLineParts = firstLine.split(/\s+/).filter(Boolean);
  if (firstLineParts.length < 2) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/settopic @username (или chat_id) #тема\nEnglish term 1\nEnglish term 2\n...",
    });
    return;
  }
  const targetRaw = firstLineParts[0];
  const topic = firstLineParts.slice(1).join(" ").replace(/^#/, "").trim();
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }
  if (!topic) {
    await tg("sendMessage", { chat_id: chatId, text: "Не указана тема (напиши после получателя, например #медицина)." });
    return;
  }

  const terms = lines
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!terms.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одного термина после первой строки (по одному English-слову на строку)." });
    return;
  }
  const termSet = new Set(terms.map((t) => t.toLowerCase()));

  let tagged = 0;
  let notFound = [];
  await withOptimisticUpdate(wordsStore(), `words:${targetId}`, () => [], (vocab) => {
    tagged = 0;
    const foundSet = new Set();
    const next = vocab.map((w) => {
      if (termSet.has(w.en.toLowerCase())) {
        tagged += 1;
        foundSet.add(w.en.toLowerCase());
        return { ...w, topic };
      }
      return w;
    });
    notFound = terms.filter((t) => !foundSet.has(t.toLowerCase()));
    return next;
  });

  let msg = `✅ Пометила темой «${topic}» у ${targetRaw}: ${tagged} слов.`;
  if (notFound.length) msg += `\nНе нашла в словаре: ${notFound.length} (${notFound.slice(0, 10).join(", ")}${notFound.length > 10 ? "…" : ""}).`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

// Только для админов: то же самое, что /delete, но для словаря КОНКРЕТНОГО
// ДРУГОГО чата — первая строка после команды это @username или chat_id,
// дальше по одному English-термину на строку (как в /delete).
async function handleDeleteFrom(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const targetRaw = lines[0];
  if (!targetRaw) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/deletefrom @username (или chat_id)\nEnglish term 1\nEnglish term 2\n...",
    });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }
  const termLines = lines.slice(1);
  if (!termLines.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одного термина после первой строки." });
    return;
  }
  const terms = termLines.map(extractEnForDelete).filter(Boolean);
  const { removedCount, total } = await deleteWords(targetId, terms);
  const notFound = terms.length - removedCount;
  let msg = `🗑 Удалила у ${targetRaw}: ${removedCount}. Осталось у него в словаре: ${total}.`;
  if (notFound > 0) msg += `\nНе нашла: ${notFound}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

// Только для админов: общая библиотека (видна всем ученикам сразу,
// отдельно от их личного словаря). Первая строка после команды —
// "<сложность> #<тема>", например "A1-A2 #медицина".
function parseSharedHeaderLine(line) {
  const parts = line.trim().split(/\s+/);
  const hashIdx = parts.findIndex((p) => p.startsWith("#"));
  if (hashIdx === -1) return null;
  const difficulty = parts.slice(0, hashIdx).join(" ").trim();
  const topic = parts.slice(hashIdx).join(" ").replace(/^#/, "").trim();
  if (!difficulty || !topic) return null;
  return { difficulty, topic };
}

async function handleAddShared(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText.split(/\r?\n/);
  const header = parseSharedHeaderLine(lines[0] || "");
  if (!header) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/addshared A1-A2 #медицина\nEnglish . перевод\n... (можно много строк)",
    });
    return;
  }
  const pairs = lines
    .slice(1)
    .map(parseVocabLine)
    .filter(Boolean);
  if (!pairs.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одной пары «слово - перевод» после первой строки." });
    return;
  }
  const { added, total } = await addSharedWords(header.difficulty, header.topic, pairs);
  const skippedDupes = pairs.length - added;
  let msg = `✅ Добавлено в общую библиотеку (${header.difficulty} / ${header.topic}): ${added}. Всего там сейчас: ${total}.`;
  if (skippedDupes) msg += `\nПропущено как дубли: ${skippedDupes}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

async function handleDeleteShared(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText.split(/\r?\n/);
  const header = parseSharedHeaderLine(lines[0] || "");
  if (!header) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/deleteshared A1-A2 #медицина\nEnglish term 1\nEnglish term 2\n...",
    });
    return;
  }
  const terms = lines
    .slice(1)
    .map(extractEnForDelete)
    .filter(Boolean);
  if (!terms.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одного термина после первой строки." });
    return;
  }
  const { removedCount, total } = await deleteSharedWords(header.difficulty, header.topic, terms);
  const notFound = terms.length - removedCount;
  let msg = `🗑 Удалила из общей библиотеки (${header.difficulty} / ${header.topic}): ${removedCount}. Осталось там: ${total}.`;
  if (notFound > 0) msg += `\nНе нашла: ${notFound}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

async function handleSharedList(chatId) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const entries = await listSharedLibrary();
  if (!entries.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Общая библиотека пока пустая. Добавить: /addshared <сложность> #<тема>" });
    return;
  }
  const byDifficulty = new Map();
  for (const e of entries) {
    if (!byDifficulty.has(e.difficultySlug)) byDifficulty.set(e.difficultySlug, []);
    byDifficulty.get(e.difficultySlug).push(e);
  }
  const lines = ["📖 Общая библиотека:"];
  for (const [difficulty, topics] of byDifficulty) {
    lines.push(`\n${difficulty}:`);
    for (const t of topics) lines.push(`  • ${t.topicSlug} — ${t.count} слов`);
  }
  await tg("sendMessage", { chat_id: chatId, text: lines.join("\n") });
}

// Только для админов: показывает весь словарь конкретного другого чата —
// сгруппированный по темам (сначала общие слова, потом по каждой теме),
// разбитый на несколько сообщений, если не влезает в одно (лимит Telegram —
// 4096 символов на сообщение, берём запас поменьше).
async function handleViewVocab(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const targetRaw = argText.trim();
  if (!targetRaw) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /viewvocab @username (или chat_id)" });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }
  const vocab = await getVocab(targetId);
  if (!vocab.length) {
    await tg("sendMessage", { chat_id: chatId, text: `У ${targetRaw} словарь сейчас пуст.` });
    return;
  }

  const byTopic = new Map();
  for (const w of vocab) {
    const key = w.topic || GENERAL_TOPIC;
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(w);
  }
  const orderedKeys = [...byTopic.keys()].sort((a) => (a === GENERAL_TOPIC ? -1 : 1));

  const lines = [`📖 Словарь ${targetRaw} — всего ${vocab.length} слов:`, ""];
  for (const key of orderedKeys) {
    const words = byTopic.get(key);
    lines.push(`— ${topicLabel(key)} (${words.length}) —`);
    for (const w of words) lines.push(`${w.en} . ${w.ru}`);
    lines.push("");
  }

  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > 3500) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await tg("sendMessage", { chat_id: chatId, text: chunk });
  }
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
  await tg("sendMessage", { chat_id: chatId, text: msg, reply_markup: await mainReplyKeyboard(chatId) });
}
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

  if (data === "mode:vocab") {
    await handleModeVocab(chatId);
    return;
  }

  if (data.startsWith("vtopic:")) {
    const sel = data.slice(7);
    const vocab = await getVocab(chatId);
    const topics = getDistinctTopics(vocab);
    const topic = sel === "all" ? null : topics[parseInt(sel, 10)] || null;
    const label = `📚 Режим: Лексика — ${topic ? topicLabel(topic) : "все темы"}`;
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, label, "vocab", undefined, undefined, topic, null);
    return;
  }

  if (data === "vsource:personal") {
    await handleModeVocabPersonal(chatId);
    return;
  }

  if (data === "vsource:shared") {
    const entries = await listSharedLibrary();
    const difficulties = [...new Set(entries.map((e) => e.difficultySlug))];
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Общая библиотека — какая сложность?",
      reply_markup: {
        inline_keyboard: difficulties.map((d, i) => [{ text: d, callback_data: `vshareddiff:${i}` }]),
      },
    });
    return;
  }

  if (data.startsWith("vshareddiff:")) {
    const diffIdx = parseInt(data.slice(12), 10);
    const entries = await listSharedLibrary();
    const difficulties = [...new Set(entries.map((e) => e.difficultySlug))];
    const difficulty = difficulties[diffIdx];
    if (!difficulty) return;
    const topicsForDifficulty = entries.filter((e) => e.difficultySlug === difficulty);
    await tg("sendMessage", {
      chat_id: chatId,
      text: `${difficulty} — какая тема?`,
      reply_markup: {
        inline_keyboard: topicsForDifficulty.map((t, i) => [{ text: `${t.topicSlug} (${t.count})`, callback_data: `vsharedtopic:${diffIdx}:${i}` }]),
      },
    });
    return;
  }

  if (data.startsWith("vsharedtopic:")) {
    const [, diffIdxStr, topicIdxStr] = data.split(":");
    const diffIdx = parseInt(diffIdxStr, 10);
    const topicIdx = parseInt(topicIdxStr, 10);
    const entries = await listSharedLibrary();
    const difficulties = [...new Set(entries.map((e) => e.difficultySlug))];
    const difficulty = difficulties[diffIdx];
    if (!difficulty) return;
    const topicsForDifficulty = entries.filter((e) => e.difficultySlug === difficulty);
    const chosen = topicsForDifficulty[topicIdx];
    if (!chosen) return;
    const label = `📖 Общая библиотека — ${difficulty} — ${chosen.topicSlug}`;
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, label, "vocab", undefined, undefined, null, {
      difficulty: chosen.difficultySlug,
      topic: chosen.topicSlug,
    });
    return;
  }

  if (data === "mode:grammar") {
    await handleModeGrammar(chatId);
    return;
  }

  if (data === "mode:irregular") {
    await handleModeIrregular(chatId);
    return;
  }

  if (data === "ilevel:a" || data === "ilevel:b" || data === "ilevel:c") {
    const level = data.slice(7);
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Уровень ${IRREGULAR_LEVEL_LABELS[level]} — какой формат тренировки?`,
      reply_markup: {
        inline_keyboard: Object.entries(IRREGULAR_EXERCISE_TYPES).map(([key, label]) => [
          { text: label, callback_data: `itype:${level}:${key}` },
        ]),
      },
    });
    return;
  }

  if (data.startsWith("itype:")) {
    const [, level, exerciseType] = data.split(":");
    const label = `🔄 Неправильные глаголы — ${IRREGULAR_LEVEL_LABELS[level]} — ${IRREGULAR_EXERCISE_TYPES[exerciseType] || exerciseType}`;
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, label, "irregular", level, exerciseType);
    return;
  }

  if (data.startsWith("gtype:")) {
    const exerciseType = data.slice(6);
    const label = `📝 Режим: Грамматика — ${GRAMMAR_EXERCISE_TYPES[exerciseType] || exerciseType}`;
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, label, "grammar", undefined, exerciseType);
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

  const mode = pending.mode === "grammar" || pending.mode === "irregular" ? pending.mode : "vocab";
  const fullVocab =
    mode === "vocab" ? (pending.shared ? await getSharedVocab(pending.shared.difficulty, pending.shared.topic) : await getVocab(chatId)) : null;
  const vocab = mode === "vocab" ? (pending.shared ? fullVocab : filterByTopic(fullVocab, pending.topic || null)) : null;
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

    const statsSuffix = mode === "vocab" ? `\n\n${statsLine(seenEnList.length, vocab.length)}` : "";
    const resultText = `${isCorrect ? "✅" : "❌"} *${mdEscape(pending.correctEn)}* — ${mdEscape(pending.correctRu)}${statsSuffix}`;

    if (mode === "grammar") {
      picked = buildGrammarPicked(resultText, pending.correctEn, pending.exerciseType || "tenses");
    } else if (mode === "irregular") {
      picked = buildIrregularPicked(resultText, pending.correctEn, pending.level || "a", pending.exerciseType || "triplet");
    } else if (vocab.length) {
      picked = buildQuestion(vocab, s.wrong, resultText, pending.correctEn, seenEnList, recentTailList);
      picked.topic = pending.topic || null;
      picked.shared = pending.shared || null;
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

// Напоминания о практике: если человек не появлялся дольше REMIND_AFTER_MS
// (и мы не напоминали ему за последние REMIND_MIN_GAP_MS, чтобы не слать
// каждый день подряд одному и тому же), присылаем ему короткий пинг.
// Каждый может отключить это себе командой /reminders off.
const REMIND_AFTER_MS = 2 * 24 * 60 * 60 * 1000; // 2 дня без активности
const REMIND_MIN_GAP_MS = 3 * 24 * 60 * 60 * 1000; // не чаще раза в 3 дня

async function sendReminders() {
  const ids = await identityStore().list();
  const entries = ids && ids.blobs ? ids.blobs : [];
  const now = Date.now();
  let sentCount = 0;
  for (const entry of entries) {
    const info = await identityStore().get(entry.key, { type: "json" });
    if (!info) continue;
    if (info.remindersEnabled === false) continue;

    const lastSeenMs = info.lastSeen ? new Date(info.lastSeen).getTime() : 0;
    if (!lastSeenMs || now - lastSeenMs < REMIND_AFTER_MS) continue;

    const lastReminderMs = info.lastReminderSent ? new Date(info.lastReminderSent).getTime() : 0;
    if (lastReminderMs && now - lastReminderMs < REMIND_MIN_GAP_MS) continue;

    const chatId = entry.key;
    try {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "👋 Давно не виделись! Может, немного попрактикуемся? Жми /start или любую кнопку внизу.\n\n(Не хочешь получать напоминания — напиши /reminders off.)",
      });
      sentCount += 1;
      await identityStore().setJSON(chatId, { ...info, lastReminderSent: new Date().toISOString() });
    } catch (err) {
      // не критично — пропускаем этого человека (например, заблокировал бота) и идём дальше
    }
  }
  return sentCount;
}

async function handleReminders(chatId, argText) {
  const arg = argText.trim().toLowerCase();
  const identity = await identityStore().get(String(chatId), { type: "json" });
  if (arg === "off") {
    await identityStore().setJSON(String(chatId), { ...(identity || {}), remindersEnabled: false });
    await tg("sendMessage", { chat_id: chatId, text: "Хорошо, напоминания о практике отключены. Включить обратно — /reminders on." });
    return;
  }
  if (arg === "on") {
    await identityStore().setJSON(String(chatId), { ...(identity || {}), remindersEnabled: true });
    await tg("sendMessage", { chat_id: chatId, text: "Готово, буду иногда напоминать о практике, если долго не будет активности." });
    return;
  }
  const enabled = !identity || identity.remindersEnabled !== false;
  await tg("sendMessage", {
    chat_id: chatId,
    text: `Напоминания сейчас ${enabled ? "включены" : "выключены"}.\n/reminders on — включить\n/reminders off — выключить`,
  });
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
  if (text === BTN_VOCAB) return handleModeVocab(chatId);
  if (text === BTN_IRREGULAR) return handleModeIrregular(chatId);
  if (text === BTN_GRAMMAR) return handleModeGrammar(chatId);
  if (text === "/mode") return handleMode(chatId);
  if (text === "/hidemenu" || text === BTN_HIDE) return handleHideMenu(chatId);
  if (text === "/showmenu") return handleShowMenu(chatId);
  if (text === "/whoami") {
    await tg("sendMessage", { chat_id: chatId, text: `Твой chat_id: ${chatId}` });
    return;
  }
  if (/^\/reminders(@\w+)?\s*/i.test(text)) {
    return handleReminders(chatId, text.replace(/^\/reminders(@\w+)?\s*/i, ""));
  }
  if (/^\/claimadmin(@\w+)?\s*/i.test(text)) {
    const provided = text.replace(/^\/claimadmin(@\w+)?\s*/i, "").trim();
    if (!provided || provided !== CLAIM_ADMIN_SECRET) {
      await tg("sendMessage", { chat_id: chatId, text: "Неверный секрет." });
      return;
    }
    await adminStore().setJSON(String(chatId), { grantedAt: new Date().toISOString() });
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Готово — теперь тебе доступна команда /students.",
      reply_markup: await mainReplyKeyboard(chatId),
    });
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
  if (/^\/removedefault(@\w+)?\s*/i.test(text)) {
    return handleRemoveDefault(chatId, text.replace(/^\/removedefault(@\w+)?\s*/i, ""));
  }
  if (/^\/addto(@\w+)?\s*/i.test(text)) {
    return handleAddTo(chatId, text.replace(/^\/addto(@\w+)?\s*/i, ""));
  }
  if (/^\/settopic(@\w+)?\s*/i.test(text)) {
    return handleSetTopic(chatId, text.replace(/^\/settopic(@\w+)?\s*/i, ""));
  }
  if (/^\/deletefrom(@\w+)?\s*/i.test(text)) {
    return handleDeleteFrom(chatId, text.replace(/^\/deletefrom(@\w+)?\s*/i, ""));
  }
  if (/^\/addshared(@\w+)?\s*/i.test(text)) {
    return handleAddShared(chatId, text.replace(/^\/addshared(@\w+)?\s*/i, ""));
  }
  if (/^\/deleteshared(@\w+)?\s*/i.test(text)) {
    return handleDeleteShared(chatId, text.replace(/^\/deleteshared(@\w+)?\s*/i, ""));
  }
  if (text === "/sharedlist") return handleSharedList(chatId);
  if (/^\/viewvocab(@\w+)?\s*/i.test(text)) {
    return handleViewVocab(chatId, text.replace(/^\/viewvocab(@\w+)?\s*/i, ""));
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

// Обрабатывает запрос от /admin.html — тот же смысл, что у /addto в
// Telegram, но по HTTP и в JSON, чтобы страница могла вызвать это через
// fetch(). Проверка — тем же секретом, что и /claimadmin.
async function handleAdminApi(body) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (body.adminSecret !== CLAIM_ADMIN_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "Неверный секрет." }), { status: 403, headers });
  }

  const targetRaw = (body.target || "").trim();
  if (!targetRaw) {
    return new Response(JSON.stringify({ ok: false, error: "Не указан получатель." }), { status: 400, headers });
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    return new Response(JSON.stringify({ ok: false, error: `Не нашла «${targetRaw}» — проверь @username или chat_id.` }), {
      status: 404,
      headers,
    });
  }

  const wordsText = body.words || "";
  const lines = wordsText.split(/\r?\n/);
  const pairs = [];
  for (const line of lines) {
    const parsed = parseVocabLine(line);
    if (parsed) pairs.push(parsed);
  }
  if (!pairs.length) {
    return new Response(JSON.stringify({ ok: false, error: "Не нашла ни одной пары «слово - перевод»." }), { status: 400, headers });
  }

  const { added, total } = await addWords(targetId, pairs);
  return new Response(
    JSON.stringify({ ok: true, added, total, skippedDupes: pairs.length - added, resolvedTarget: targetId }),
    { status: 200, headers }
  );
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
      // GET ?remind=<секрет> — запускается по расписанию (см.
      // .github/workflows/remind.yml) раз в день, шлёт напоминания тем, кто
      // давно не появлялся.
      if (url.searchParams.get("remind") === WEBHOOK_SECRET) {
        const count = await sendReminders();
        return new Response(JSON.stringify({ ok: true, remindersSent: count }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      // GET ?seedshared=<секрет> — единоразовая автозагрузка стартового
      // набора общей библиотеки (см. SEED_SHARED_LIBRARY выше).
      // Срабатывает автоматически после деплоя (см.
      // .github/workflows/seed-shared-library.yml) — вручную вызывать не
      // нужно. Безопасно вызывать повторно: дубли просто пропускаются.
      if (url.searchParams.get("seedshared") === WEBHOOK_SECRET) {
        const result = await seedSharedLibraryOnce();
        return new Response(JSON.stringify({ ok: true, ...result }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      // GET ?export=<секрет>&target=<@username или chat_id> — отдаёт
      // словарь конкретного человека как JSON. Тот же секрет, что у
      // /claimadmin. Существует, чтобы можно было прислать эту ссылку
      // прямо в чат с Клодом — он получит данные без переписки через бота.
      if (url.searchParams.get("export") === CLAIM_ADMIN_SECRET) {
        const targetRaw = url.searchParams.get("target");
        if (!targetRaw) {
          return new Response(JSON.stringify({ ok: false, error: "Не указан target." }), {
            status: 400,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        const targetId = await resolveTarget(targetRaw);
        if (!targetId) {
          return new Response(JSON.stringify({ ok: false, error: `Не нашла «${targetRaw}».` }), {
            status: 404,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        const vocab = await getVocab(targetId);
        return new Response(JSON.stringify({ ok: true, target: targetRaw, chatId: targetId, count: vocab.length, vocab }, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }
    return new Response("ok", { status: 200 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Отдельный "административный" HTTP API — НЕ от Telegram, а от статической
  // страницы /admin.html: позволяет добавлять слова в чей-то словарь прямо
  // с сайта, без переписки в Telegram. Отличается от настоящих апдейтов
  // Telegram наличием поля adminSecret (у Telegram такого поля не бывает).
  if (body && body.adminSecret !== undefined) {
    return handleAdminApi(body);
  }

  if (WEBHOOK_SECRET) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
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
