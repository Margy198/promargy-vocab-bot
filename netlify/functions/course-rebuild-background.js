// Пересборка контента из Notion без кода (Netlify background function, до 15 минут).
// Запускается из кабинета учителя (telegram-webhook → contentRebuild) и пишет результат в Blobs
// `vocab-bot-course`, откуда бот и приложение читают его вместо встроенного бандла.
//
// Режимы (body.mode):
//   course      — курс A0–C1 из страниц Notion. Уровни обрабатываются по одному за вызов
//                 (body.levels = очередь кодов), после уровня функция вызывает сама себя
//                 со следующим — так укладываемся в лимит времени. Ключи:
//                 course:level:<code>, course:topic:<id>, course:index, course:meta.
//   grammar     — задания at/in/on, условные, герундий из базы Notion → grammar:items.
//   student     — задания одного ученика: подстраницы его страницы «Домашнее» в Notion
//                 (body.chatId; страницу привязывает преподаватель в кабинете) → stu:<chatId>:*.
//   seedGrammar — один раз создать эту базу в Notion под корневой страницей курса
//                 и залить в неё встроенные задания (чтобы не набирать руками) → grammar:dbId.
//
// Нужны переменные окружения: NOTION_TOKEN (интеграция Notion, которой расшарена страница курса),
// TELEGRAM_WEBHOOK_SECRET (защита от чужих вызовов). Необязательно: NOTION_COURSE_ROOT (id корневой
// страницы плана; по умолчанию «Твой путь в английский»), NOTION_GRAMMAR_DB (id базы заданий).
import { getStore } from "@netlify/blobs";
import { buildLevel, assembleIndex, parseLevelPage, blocksToMarkdown, buildTopic } from "../lib/course-builder.mjs";
import { normalizeHomework } from "../lib/homework-normalizer.mjs";
import { STUDENT_NOTION_SEED } from "../lib/student-notion-seed.mjs";
import { PREP_ITEMS_A, PREP_ITEMS_B, COND_ITEMS, GERUND_PREP_ITEMS } from "../../data/grammar-extra.mjs";
import BUNDLED_INDEX from "../../data/course/index.mjs";

const store = () => getStore("vocab-bot-course", { consistency: "strong" });
const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DEFAULT_ROOT = "34c2f2f8690d814e82e8fb81e078333e";
// Бизнес-версия плана («для работы») — отдельное дерево страниц, пишется в biz:* (переменная NOTION_BUSINESS_ROOT — необязательно)
const DEFAULT_BIZ_ROOT = "4022f2f8690d8143b223fce9744efecb";
const PFX = (track) => (track === "business" ? "biz" : "course");
export const GRAMMAR_TYPES = [
  ["prepA", "at/in/on — до B1", PREP_ITEMS_A],
  ["prepB", "at/in/on — B1+ и бизнес", PREP_ITEMS_B],
  ["condB1", "Условные — B1+", COND_ITEMS],
  ["gerundPrep", "Герундий и инфинитив — до B1", GERUND_PREP_ITEMS],
];
const STATUS_KEY = "rebuild:status";

// ---------- Notion API с ограничением скорости и повторами ----------
let lastCall = 0;
async function notion(path, { method = "GET", body } = {}, attempt = 0) {
  const gap = 340 - (Date.now() - lastCall); if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  lastCall = Date.now();
  const r = await fetch(NOTION + path, { method, headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 429 || r.status >= 500) {
    if (attempt >= 5) throw new Error(`Notion ${r.status} после 5 попыток: ${path}`);
    const wait = Number(r.headers.get("retry-after") || 0) * 1000 || 1500 * (attempt + 1);
    await new Promise((res) => setTimeout(res, wait));
    return notion(path, { method, body }, attempt + 1);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Notion ${r.status}: ${data.message || data.code || path}`);
  return data;
}
async function allChildren(blockId) {
  const out = []; let cursor;
  do {
    const d = await notion(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...(d.results || [])); cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return out;
}
// Дерево блоков страницы: во вложенные блоки спускаемся, в дочерние страницы/базы — нет.
async function blockTree(blockId, depth = 0) {
  const blocks = await allChildren(blockId);
  for (const b of blocks) {
    if (b.has_children && b.type !== "child_page" && b.type !== "child_database" && depth < 8) b.children = await blockTree(b.id, depth + 1);
  }
  return blocks;
}
function pageTitle(page) {
  const props = page.properties || {};
  const tp = Object.values(props).find((p) => p && p.type === "title");
  const title = tp && tp.title ? tp.title.map((r) => r.plain_text).join("") : "";
  const emoji = page.icon && page.icon.type === "emoji" ? page.icon.emoji : "";
  return { title: title.trim(), emoji };
}
const nid = (id) => String(id || "").replace(/-/g, "");

async function setStatus(patch) {
  const cur = (await store().get(STATUS_KEY, { type: "json" })) || {};
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await store().setJSON(STATUS_KEY, next);
  return next;
}
async function appendLog(line) {
  const cur = (await store().get(STATUS_KEY, { type: "json" })) || {};
  const log = [...(cur.log || []), `${new Date().toISOString().slice(11, 19)} ${line}`].slice(-60);
  await store().setJSON(STATUS_KEY, { ...cur, log, updatedAt: new Date().toISOString() });
}

// ---------- курс ----------
async function discoverLevels(rootId) {
  const blocks = await allChildren(rootId);
  const levels = [];
  for (const b of blocks) {
    if (b.type !== "child_page") continue;
    const title = (b.child_page && b.child_page.title) || "";
    const m = title.match(/^\s*([ABC][0-2])\s*[—–-]/);
    if (m) levels.push({ code: m[1], id: nid(b.id), title: title.trim() });
  }
  // fallback: ссылки link_to_page на страницы уровней
  if (!levels.length) for (const b of blocks) if (b.type === "link_to_page" && b.link_to_page.page_id) { const p = await notion(`/pages/${b.link_to_page.page_id}`); const { title } = pageTitle(p); const m = title.match(/^\s*([ABC][0-2])\s*[—–-]/); if (m) levels.push({ code: m[1], id: nid(p.id), title }); }
  const order = ["A0", "A1", "A2", "B1", "B2", "C1"];
  levels.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
  return levels;
}
async function rebuildLevel(levelRef) {
  const page = await notion(`/pages/${levelRef.id}`);
  const { title, emoji } = pageTitle(page);
  const tree = await blockTree(levelRef.id);
  // названия дочерних страниц — для ссылок в markdown
  const titles = new Map();
  const childPages = [];
  const walk = (bs) => { for (const b of bs) { if (b.type === "child_page") { titles.set(nid(b.id), { title: b.child_page.title, emoji: "" }); childPages.push({ id: nid(b.id), title: b.child_page.title }); } if (b.children) walk(b.children); } };
  walk(tree);
  const md = blocksToMarkdown(tree, titles);
  const parsed = parseLevelPage(md);
  const topics = parsed.topics;
  const known = new Set(topics.map((t) => t.id));
  // дочерние страницы уровня, не попавшие в нумерованный список: мосты и экзамены
  let n = topics.length;
  for (const cp of childPages) {
    if (known.has(cp.id)) continue;
    const t = cp.title || "";
    if (/Мост/i.test(t)) { n += 1; topics.push({ n, id: cp.id, emoji: "", title: t, description: "", contains: "", kind: "bridge" }); }
    else if (/Экзамен|чекпоинт|Checkpoint|\(1\)$/i.test(t)) { n += 1; topics.push({ n, id: cp.id, emoji: "", title: t, description: "", contains: "", kind: "other" }); }
    // прочие подстраницы (словарь, заметки) в курс не берём
  }
  const bodies = new Map();
  for (const t of topics) {
    if (/\(1\)$/.test(t.title)) continue; // скрытые дубликаты — не тратим запросы
    const p = await notion(`/pages/${t.id}`);
    const pt = pageTitle(p);
    if (pt.title) t.title = pt.title;
    if (pt.emoji) t.emoji = pt.emoji;
    const tTree = await blockTree(t.id);
    const tt = new Map(); const w2 = (bs) => { for (const b of bs) { if (b.type === "child_page") tt.set(nid(b.id), { title: b.child_page.title, emoji: "" }); if (b.children) w2(b.children); } }; w2(tTree);
    bodies.set(t.id, blocksToMarkdown(tTree, tt));
  }
  const lv = { code: levelRef.code, title: title || levelRef.title, emoji, intro: parsed.intro, checkpoint: parsed.checkpoint, topics };
  const built = buildLevel(lv, bodies);
  // качество: тема без разделов — подозрительно
  for (const [id, tp] of built.topics) if (!tp.sections.length && tp.kind === "topic") built.log.push(`тема «${tp.title}» без разделов (## …) — проверь структуру страницы`);
  return built;
}
// Сквозные бизнес-блоки: дочерние страницы корня бизнес-плана, кроме страниц уровней → «уровень» BIZ
async function discoverBlocks(rootId) {
  const blocks = await allChildren(rootId);
  return blocks.filter((b) => b.type === "child_page").map((b) => ({ id: nid(b.id), title: ((b.child_page && b.child_page.title) || "").trim() }))
    .filter((p) => p.title && !/^\s*[ABC][0-2]\s*[—–-]/.test(p.title) && !/\(1\)$/.test(p.title));
}
async function rebuildBlocks(rootId) {
  const pages = await discoverBlocks(rootId);
  const topics = []; const bodies = new Map();
  for (const [i, cp] of pages.entries()) {
    const p = await notion(`/pages/${cp.id}`);
    const pt = pageTitle(p);
    let title = pt.title || cp.title; let emoji = pt.emoji || "";
    const em = title.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+/u);
    if (em) { emoji = emoji || em[1]; title = title.slice(em[0].length).trim(); }
    const tTree = await blockTree(cp.id);
    const tt = new Map(); const w2 = (bs) => { for (const b of bs) { if (b.type === "child_page") tt.set(nid(b.id), { title: b.child_page.title, emoji: "" }); if (b.children) w2(b.children); } }; w2(tTree);
    bodies.set(cp.id, blocksToMarkdown(tTree, tt));
    topics.push({ n: i + 1, id: cp.id, emoji, title, description: "", contains: "", kind: "topic", category: "business" });
  }
  return buildLevel({ code: "BIZ", title: "Бизнес-блоки", emoji: "💼", intro: "Их не нужно проходить по порядку — открывай тот, который нужен на этой неделе.", checkpoint: [], topics }, bodies);
}
async function writeLevel(built, track) {
  for (const [id, tp] of built.topics) await store().setJSON(`${PFX(track)}:topic:${id}`, tp);
  await store().setJSON(`${PFX(track)}:level:${built.record.code}`, built.record);
}
async function publishIndex(bundledIndex, track) {
  const pfx = PFX(track);
  // собираем индекс из уровней в Blobs; для уровней, которых там нет, берём встроенные
  const codes = ["A0", "A1", "A2", "B1", "B2", "C1", ...(track === "business" ? ["BIZ"] : [])];
  const records = []; const sources = {};
  for (const c of codes) {
    const rec = await store().get(`${pfx}:level:${c}`, { type: "json" });
    if (rec && Array.isArray(rec.topics)) { records.push(rec); sources[c] = "notion"; }
    else if (track !== "business") { const b = bundledIndex && bundledIndex.levels.find((l) => l.code === c); if (b) { records.push(JSON.parse(JSON.stringify(b))); sources[c] = "bundle"; } }
  }
  const index = assembleIndex(records, new Date().toISOString().slice(0, 10));
  await store().setJSON(`${pfx}:index`, index);
  await store().setJSON(`${pfx}:meta`, { builtAt: new Date().toISOString(), sources, topics: index.levels.reduce((a, l) => a + l.topics.length, 0) });
  return index;
}

async function runCourse(body) {
  const track = body.track === "business" ? "business" : "general";
  const rootId = track === "business" ? nid(process.env.NOTION_BUSINESS_ROOT || DEFAULT_BIZ_ROOT) : nid(process.env.NOTION_COURSE_ROOT || DEFAULT_ROOT);
  let queue = Array.isArray(body.levels) && body.levels.length ? body.levels : null;
  if (!queue) {
    await setStatus({ mode: track === "business" ? "bizCourse" : "course", status: "running", startedAt: new Date().toISOString(), finishedAt: null, by: body.by || null, log: [], done: [], failed: [], error: null });
    await appendLog("ищу страницы уровней в Notion…");
    const levels = await discoverLevels(rootId);
    if (!levels.length) throw new Error("не нашла страницы уровней (A0 — …, A1 — …) под корневой страницей. Проверь, что интеграции открыт доступ к странице плана.");
    await appendLog(`уровни: ${levels.map((l) => l.code).join(", ")}`);
    queue = levels.map((l) => `${l.code}:${l.id}`);
    if (track === "business") queue.push(`BIZ:${rootId}`);
    await setStatus({ total: queue.length, queue });
  }
  const [code, id] = queue[0].split(":");
  await appendLog(`уровень ${code}: читаю страницы…`);
  let failed = false;
  try {
    const built = code === "BIZ" ? await rebuildBlocks(id) : await rebuildLevel({ code, id });
    await writeLevel(built, track);
    for (const l of built.log) await appendLog(`${code}: ${l}`);
    await appendLog(`уровень ${code}: ${built.record.topics.length} тем записано`);
  } catch (e) {
    failed = true;
    await appendLog(`уровень ${code}: ошибка — ${String((e && e.message) || e)}. Этот уровень останется прежним, иду дальше.`);
  }
  const rest = queue.slice(1);
  const cur = (await store().get(STATUS_KEY, { type: "json" })) || {};
  await setStatus({ done: [...(cur.done || []), code], failed: [...(cur.failed || []), ...(failed ? [code] : [])], queue: rest });
  if (rest.length) {
    // следующий уровень — отдельным вызовом, чтобы не упереться в лимит времени
    await selfInvoke({ ...body, levels: rest });
    return;
  }
  await appendLog("собираю индекс курса…");
  const index = await publishIndex(BUNDLED_INDEX, track);
  const fin = (await store().get(STATUS_KEY, { type: "json" })) || {};
  const failedLevels = fin.failed || [];
  await setStatus({ status: failedLevels.length ? "warning" : "done", finishedAt: new Date().toISOString(), topics: index.levels.reduce((a, l) => a + l.topics.length, 0), error: failedLevels.length ? `не удалось обновить уровни: ${failedLevels.join(", ")} — для них оставлена прежняя версия` : null });
  await appendLog(`готово: ${index.levels.length} уровней, ${index.levels.reduce((a, l) => a + l.topics.length, 0)} тем${failedLevels.length ? ` (не обновились: ${failedLevels.join(", ")})` : ""}`);
}
async function selfInvoke(body) {
  const base = (process.env.URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("нет переменной URL — не могу продолжить следующим уровнем");
  const r = await fetch(`${base}/.netlify/functions/course-rebuild-background`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok && r.status !== 202) throw new Error(`не удалось запустить следующий уровень: ${r.status}`);
}

// ---------- задания ученика из Notion ----------
// Привязку (stu:<chatId>:link) ставит только преподаватель. Здесь читаем подстраницы привязанной страницы,
// приводим каждую к шаблону курса и сохраняем как тему. Прав доступа это не меняет.
// Подстраницы блока, включая лежащие внутри колонок, тогглов и синхронных блоков. В сами подстраницы и таблицы не заходим.
const STU_CONTAINERS = new Set(["column_list", "column", "toggle", "synced_block", "callout", "quote", "bulleted_list_item", "numbered_list_item", "paragraph", "heading_1", "heading_2", "heading_3"]);
async function childPagesDeep(blockId, depth = 0, out = []) {
  for (const b of await allChildren(blockId)) {
    if (b.type === "child_page") { out.push({ id: nid(b.id), title: ((b.child_page && b.child_page.title) || "").trim(), createdAt: b.created_time || "" }); continue; }
    if (b.has_children && STU_CONTAINERS.has(b.type) && depth < 4) await childPagesDeep(b.id, depth + 1, out);
  }
  return out;
}
// Уведомление «новое задание» шлет telegram-webhook (там тексты и кнопка). Здесь — вызов с проверкой ответа и одним повтором;
// если не вышло, blob stu:<id>:notify остается, и следующее обновление попробует снова (до 3 дней).
async function deliverStudentNotice(chatId, log) {
  let note = null; try { note = await store().get(`stu:${chatId}:notify`, { type: "json" }); } catch (e) { note = null; }
  if (!note || !Array.isArray(note.pages) || !note.pages.length) return;
  if (note.at && Date.now() - Date.parse(note.at) > 3 * 24 * 3600 * 1000) { try { await store().delete(`stu:${chatId}:notify`); } catch (e) {} log.push("старое уведомление отброшено (больше 3 дней)"); return; }
  const base = (process.env.URL || "").replace(/\/+$/, "");
  const url = `${base}/telegram-webhook?stunotify=${encodeURIComponent(process.env.TELEGRAM_WEBHOOK_SECRET || "")}&chat=${chatId}`;
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { const r = await fetch(url); if (r.ok) { log.push(`уведомление ученику отправлено (заданий: ${note.pages.length})`); return; } last = `HTTP ${r.status}`; }
    catch (e) { last = String((e && e.message) || e).slice(0, 80); }
    await new Promise((res) => setTimeout(res, 3000));
  }
  log.push(`уведомление не отправлено (${last}) — повторю при следующем обновлении`);
}
// ---------- Отметка «сделано» в карточке урока и напоминание накануне урока ----------
const LESSONS_DB = "78ebeb3357284c02993e5ced3dc20c36"; // база «📝 Уроки» (data source 05e17d52-db8f-44fa-95ea-3ba6481ced75)
const LESSONS_STUDENT_PROP = "✨Ученики база данных", LESSONS_HW_PROP = "Домашнее", LESSONS_DATE_PROP = "дата";
const MSK_MS = 3 * 3600 * 1000;
const mskDate = (ms) => new Date(ms + MSK_MS).toISOString().slice(0, 10);
const ruDay = (ymd) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
// Страница ученика в базе «Ученики»: привязка может вести на саму страницу или на ее подстраницу «Домашнее» — поднимаемся по родителям
async function studentPageOf(chatId) {
  const link = await store().get(`stu:${chatId}:link`, { type: "json" });
  if (!link || !link.pageId) return null;
  if (link.studentPageId) return link.studentPageId;
  let id = link.pageId;
  for (let i = 0; i < 5 && id; i++) {
    const pg = await notion(`/pages/${id}`);
    const par = pg.parent || {};
    if (par.type === "database_id" || par.type === "data_source_id") { try { await store().setJSON(`stu:${chatId}:link`, { ...link, studentPageId: id }); } catch (e) {} return id; }
    id = par.type === "page_id" ? nid(par.page_id) : null;
  }
  return null;
}
async function lessonsOf(studentPageId, n = 12) {
  const r = await notion(`/databases/${LESSONS_DB}/query`, { method: "POST", body: { filter: { property: LESSONS_STUDENT_PROP, relation: { contains: studentPageId } }, sorts: [{ property: LESSONS_DATE_PROP, direction: "descending" }], page_size: n } });
  return r.results || [];
}
const rtClean = (rt) => rt.map((x) => { const o = { type: x.type, annotations: x.annotations }; if (x.type === "text") o.text = { content: x.text.content, link: x.text.link || null }; else if (x.type === "mention") o.mention = x.mention; else if (x.type === "equation") o.equation = x.equation; return o; });
// Режим taskDone: ученик прошел задание → в карточке того урока, где оно задано, дописываем отметку; если урок не нашли — в саму страницу задания
async function runTaskDone(body) {
  const chatId = String(body.chatId || ""), topicId = String(body.topicId || "");
  if (!/^\d{1,20}$/.test(chatId) || !/^[0-9a-f]{32}$/.test(topicId)) return;
  const doneKey = `stu:${chatId}:done:${topicId}`;
  if (await store().get(doneKey, { type: "json" })) return;
  const ok = Number(body.ok) || 0, total = Number(body.total) || 0;
  const stamp = `✅ сделано в приложении ${ruDay(mskDate(Date.now()))}${total ? `, ${ok} из ${total} верно` : ""}`;
  const title = String(body.title || "").slice(0, 80);
  let where = "";
  try {
    const sp = await studentPageOf(chatId);
    if (sp) {
      for (const les of await lessonsOf(sp, 12)) {
        const rt = ((les.properties || {})[LESSONS_HW_PROP] || {}).rich_text || [];
        const hit = rt.some((x) => x.type === "mention" && x.mention && x.mention.type === "page" && nid(x.mention.page.id) === topicId);
        if (!hit) continue;
        const next = rtClean(rt).concat([{ type: "text", text: { content: `\n${title ? `«${title}» — ` : ""}${stamp}` } }]);
        await notion(`/pages/${les.id}`, { method: "PATCH", body: { properties: { [LESSONS_HW_PROP]: { rich_text: next } } } });
        where = `урок ${nid(les.id)}`; break;
      }
    }
  } catch (e) { console.error("taskDone lesson", chatId, e && e.message); }
  if (!where) {
    try { await notion(`/blocks/${topicId}/children`, { method: "PATCH", body: { children: [{ object: "block", type: "callout", callout: { icon: { emoji: "✅" }, rich_text: [{ type: "text", text: { content: stamp.replace(/^✅ /, "") } }] } }] } }); where = "страница задания"; }
    catch (e) { console.error("taskDone page", chatId, e && e.message); }
  }
  if (where) await store().setJSON(doneKey, { at: new Date().toISOString(), where, ok, total });
}
// Режим lessonRemind (раз в день, 19:07 МСК): расписание ученика выводим из последних уроков в Notion —
// если в последние 6 недель уроки шли в завтрашний день недели хотя бы дважды, напоминаем накануне
async function runLessonRemind() {
  const base = (process.env.URL || "").replace(/\/+$/, "");
  const now = Date.now(); const tomorrow = mskDate(now + 24 * 3600 * 1000); const tomorrowWd = new Date(tomorrow + "T12:00:00Z").getUTCDay();
  const sentKey = `lessonremind:${tomorrow}`;
  if (await store().get(sentKey, { type: "json" })) return;
  const keys = (await store().list({ prefix: "stu:" })).blobs.map((b) => b.key).filter((k) => /^stu:\d+:link$/.test(k));
  const summary = [];
  for (const k of keys) {
    const chatId = k.split(":")[1];
    try {
      const sp = await studentPageOf(chatId); if (!sp) continue;
      const lessons = await lessonsOf(sp, 15);
      const recent = lessons.map((l) => ((l.properties || {})[LESSONS_DATE_PROP] || {}).date).filter((d) => d && d.start).map((d) => ({ ms: Date.parse(d.start), withTime: /T/.test(d.start) })).filter((d) => d.ms >= now - 42 * 24 * 3600 * 1000);
      const same = recent.filter((d) => new Date(d.ms + MSK_MS).getUTCDay() === tomorrowWd);
      if (same.length < 2) continue;
      const times = same.filter((d) => d.withTime).map((d) => { const t = new Date(d.ms + MSK_MS); return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`; });
      const time = times.length ? times.sort((a, b) => times.filter((x) => x === b).length - times.filter((x) => x === a).length)[0] : "";
      const idx = await store().get(`stu:${chatId}:index`, { type: "json" });
      const prog = (await store().get(`progress:${chatId}`, { type: "json" })) || { topics: {} };
      const undone = ((idx && idx.topics) || []).filter((t) => !t.skipped && t.exercises > 0 && t.createdAt && now - Date.parse(t.createdAt) < 21 * 24 * 3600 * 1000 && ((prog.topics || {})[t.id] || {}).status !== "done").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      await store().setJSON(`stu:${chatId}:lesson`, { date: tomorrow, time, undone: undone.slice(0, 5).map((t) => t.title), undoneTotal: undone.length });
      const r = await fetch(`${base}/telegram-webhook?lessonremind=${encodeURIComponent(process.env.TELEGRAM_WEBHOOK_SECRET || "")}&chat=${chatId}`);
      summary.push(`${chatId}: ${time || "без времени"}, не сделано ${undone.length}, ${r.ok ? "отправлено" : "HTTP " + r.status}`);
    } catch (e) { summary.push(`${chatId}: ошибка ${String((e && e.message) || e).slice(0, 80)}`); }
  }
  await store().setJSON(sentKey, { at: new Date().toISOString(), summary });
  console.log("[lessonRemind]", summary.join(" | "));
}
const STU_VERSION = 5; // менять при правке разбора — тогда страницы пересоберутся, даже если не менялись
const STU_MAX_PAGES = 60;
async function runStudent(body) {
  const chatId = String(body.chatId || "");
  if (!/^\d{1,20}$/.test(chatId)) throw new Error("bad chatId");
  const key = (k) => `stu:${chatId}:${k}`;
  const log = [];
  const setSt = (patch) => store().setJSON(key("status"), { ...patch, log: log.slice(-40), updatedAt: new Date().toISOString() });
  const startedAt = new Date().toISOString();
  try {
    const link = await store().get(key("link"), { type: "json" });
    if (!link || !link.pageId) throw new Error("страница Notion не привязана");
    await setSt({ status: "running", startedAt });
    const rootId = nid(link.pageId);
    // Страница ученика содержит и личное (оплата, заметки), поэтому берем ТОЛЬКО подстраницы «Домашнее…»
    // (их может быть несколько, они бывают внутри колонок и тогглов). Если привязана сама «Домашнее» — берем ее.
    const rootPage = await notion(`/pages/${rootId}`);
    const isHw = (t) => /^\s*Домашн/i.test(String(t || "").replace(/<[^>]+>/g, ""));
    const hwRoots = [];
    if (isHw(pageTitle(rootPage).title)) hwRoots.push({ id: rootId, title: pageTitle(rootPage).title });
    else {
      for (const b of await childPagesDeep(rootId)) if (isHw(b.title)) hwRoots.push(b);
      if (!hwRoots.length) throw new Error("на привязанной странице нет подстраницы «Домашнее» — задания брать неоткуда");
      log.push(`подстраницы с заданиями: ${hwRoots.map((h) => `«${h.title.trim()}»`).join(", ")}`);
    }
    let pages = [];
    for (const h of hwRoots) pages.push(...(await childPagesDeep(h.id)));
    const skipped = pages.filter((p) => /для преподавателя/i.test(p.title));
    pages = pages.filter((p) => p.title && !/для преподавателя/i.test(p.title));
    if (skipped.length) log.push(`пропущено страниц «для преподавателя»: ${skipped.length}`);
    // Лимит — по дате создания, а не по месту на странице: новое задание попадает в список, куда бы его ни вставили
    if (pages.length > STU_MAX_PAGES) {
      const newest = new Set(pages.slice().sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, STU_MAX_PAGES).map((p) => p.id));
      log.push(`страниц ${pages.length} — беру ${STU_MAX_PAGES} самых новых по дате создания`);
      pages = pages.filter((p) => newest.has(p.id));
    }
    if (!pages.length) throw new Error("на привязанной странице нет подстраниц с заданиями");
    const prev = (await store().get(key("index"), { type: "json" })) || {};
    const prevById = new Map((prev.v === STU_VERSION ? prev.topics || [] : []).map((t) => [t.id, t]));
    const topics = []; let rebuilt = 0;
    for (const [i, pg] of pages.entries()) {
      try {
        const p = await notion(`/pages/${pg.id}`);
        const pt = pageTitle(p);
        const title = (pt.title || pg.title).replace(/<[^>]+>/g, "").replace(/\s*\(1\)\s*$/, "").trim();
        const editedAt = p.last_edited_time || "";
        const createdAt = p.created_time || ""; // дата создания материала в Notion — показываем ученику
        const old = prevById.get(pg.id);
        if (old && old.editedAt === editedAt) { topics.push({ ...old, n: i + 1, title, createdAt }); continue; }
        const tree = await blockTree(pg.id);
        const tt = new Map(); const w2 = (bs) => { for (const b of bs) { if (b.type === "child_page") tt.set(nid(b.id), { title: b.child_page.title, emoji: "" }); if (b.children) w2(b.children); } }; w2(tree);
        const norm = normalizeHomework(blocksToMarkdown(tree, tt), title);
        const topic = buildTopic({ id: pg.id, level: "", n: i + 1, emoji: pt.emoji || "📒", title, kind: "topic", description: "", contains: "" }, norm.md);
        topic.source = "notion-student"; topic.createdAt = createdAt;
        if (topic.droppedTranslation) log.push(`«${title.slice(0, 40)}»: упражнений на перевод пропущено: ${topic.droppedTranslation} (в приложение не берем)`);
        if (!topic.exercises.length && !topic.sections.length) {
          log.push(`«${title.slice(0, 40)}»: только перевод — страницу в приложение не берем`);
          try { await store().delete(key(`topic:${pg.id}`)); } catch (e) {}
          topics.push({ id: pg.id, n: i + 1, emoji: topic.emoji, title, editedAt, createdAt, exercises: 0, withKey: 0, theory: false, skipped: true });
          continue;
        }
        await store().setJSON(key(`topic:${pg.id}`), topic);
        rebuilt += 1;
        for (const l of norm.log) log.push(`«${title.slice(0, 40)}»: ${l}`);
        topics.push({ id: pg.id, n: i + 1, emoji: topic.emoji, title, editedAt, createdAt, exercises: topic.exercises.length, withKey: topic.exercises.filter((e) => e.answers).length, theory: topic.sections.length > 0 });
      } catch (e) { log.push(`«${pg.title.slice(0, 40)}»: не прочитана — ${String((e && e.message) || e).slice(0, 120)}`); }
    }
    if (!topics.length) throw new Error("ни одна страница не прочиталась");
    // Новые страницы → уведомление ученику. Только если список уже собирался раньше (первая сборка — без сообщений)
    // и только про свежие материалы (созданы за последние 7 дней): старые страницы молча.
    const known = new Set([...(prev.topics || []).map((t) => t.id), ...(prev.seen || [])]);
    const fresh = Array.isArray(prev.topics) ? topics.filter((t) => !known.has(t.id) && t.createdAt && Date.now() - Date.parse(t.createdAt) < 7 * 24 * 3600 * 1000) : [];
    const seen = [...new Set([...known, ...topics.map((t) => t.id)])].slice(-400);
    await store().setJSON(key("index"), { v: STU_VERSION, builtAt: new Date().toISOString(), rootId, topics, seen });
    if (fresh.length) {
      // старое недоставленное уведомление (если есть) объединяем с новым
      let prevNote = null; try { prevNote = await store().get(key("notify"), { type: "json" }); } catch (e) { prevNote = null; }
      const prevPages = prevNote && Array.isArray(prevNote.pages) ? prevNote.pages.filter((p) => !fresh.some((t) => t.id === p.id)) : [];
      await store().setJSON(key("notify"), { at: new Date().toISOString(), pages: [...fresh.map((t) => ({ id: t.id, title: t.title })), ...prevPages].slice(0, 20) });
      log.push(`новых заданий: ${fresh.length}`);
    }
    // Доставка уведомления — отдельным шагом и с повтором: если в прошлый раз вебхук не ответил, пробуем снова
    await deliverStudentNotice(chatId, log);
    log.push(`готово: страниц ${topics.length}, обновлено ${rebuilt}`);
    await setSt({ status: "done", startedAt, finishedAt: new Date().toISOString(), pages: topics.length, rebuilt });
  } catch (e) {
    let msg = String((e && e.message) || e);
    if (/Notion 404|Could not find|object_not_found/i.test(msg)) msg = "Notion не отдает эту страницу. Открой ее в Notion → «•••» → «Подключения» и добавь интеграцию бота, потом нажми «Обновить».";
    await setSt({ status: "error", startedAt, finishedAt: new Date().toISOString(), error: msg });
  }
}

// ---------- грамматика ----------
const PROP = { title: "Предложение", type: "Тип", o1: "Вариант 1", o2: "Вариант 2", o3: "Вариант 3", correct: "Верный", explain: "Объяснение", active: "Активно" };
const txt = (p) => (p && (p.rich_text || p.title) ? (p.rich_text || p.title).map((r) => (r.plain_text != null ? r.plain_text : (r.text && r.text.content) || "")).join("").trim() : "");
async function grammarDbId() { return nid(process.env.NOTION_GRAMMAR_DB || (await store().get("grammar:dbId", { type: "json" })) || ""); }
async function runGrammar(body) {
  await setStatus({ mode: "grammar", status: "running", startedAt: new Date().toISOString(), finishedAt: null, by: body.by || null, log: [], error: null });
  const dbId = await grammarDbId();
  if (!dbId) throw new Error("базы заданий ещё нет — сначала нажми «Создать базу заданий в Notion»");
  await appendLog("читаю базу заданий…");
  const rows = []; let cursor;
  do { const d = await notion(`/databases/${dbId}/query`, { method: "POST", body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } }); rows.push(...(d.results || [])); cursor = d.has_more ? d.next_cursor : null; } while (cursor);
  const byLabel = Object.fromEntries(GRAMMAR_TYPES.map(([k, label]) => [label, k]));
  const items = Object.fromEntries(GRAMMAR_TYPES.map(([k]) => [k, []])); const skipped = [];
  for (const r of rows) {
    const p = r.properties || {};
    const template = txt(p[PROP.title]); const typeName = p[PROP.type] && p[PROP.type].select ? p[PROP.type].select.name : "";
    const key = byLabel[typeName] || GRAMMAR_TYPES.find(([k]) => k === typeName)?.[0];
    const options = [txt(p[PROP.o1]), txt(p[PROP.o2]), txt(p[PROP.o3])];
    const correct = p[PROP.correct] && typeof p[PROP.correct].number === "number" ? p[PROP.correct].number : null;
    const explain = txt(p[PROP.explain]);
    const active = p[PROP.active] && p[PROP.active].type === "checkbox" ? p[PROP.active].checkbox : true;
    if (!active) continue;
    const why = !key ? `неизвестный тип «${typeName}»` : !template.includes("___") ? "нет пропуска ___" : options.some((o) => !o) ? "не все 3 варианта" : !(correct >= 1 && correct <= 3) ? "«Верный» должен быть 1, 2 или 3" : null;
    if (why) { skipped.push(`«${template.slice(0, 50) || "(без текста)"}»: ${why}`); continue; }
    items[key].push({ template, options, correctIdx: correct - 1, explain });
  }
  const counts = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.length]));
  await store().setJSON("grammar:items", { ...items, builtAt: new Date().toISOString(), counts, skipped: skipped.slice(0, 50), dbId });
  for (const s of skipped.slice(0, 20)) await appendLog(`пропущено: ${s}`);
  await setStatus({ status: "done", finishedAt: new Date().toISOString(), counts });
  await appendLog(`готово: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}${skipped.length ? `, пропущено ${skipped.length}` : ""}`);
}
async function runSeedGrammar(body) {
  await setStatus({ mode: "seedGrammar", status: "running", startedAt: new Date().toISOString(), finishedAt: null, by: body.by || null, log: [], error: null });
  let dbId = await grammarDbId();
  if (dbId) { try { await notion(`/databases/${dbId}`); } catch (e) { dbId = ""; } }
  if (!dbId) {
    const rootId = nid(process.env.NOTION_COURSE_ROOT || DEFAULT_ROOT);
    await appendLog("создаю базу «Задания бота» под страницей курса…");
    const db = await notion("/databases", { method: "POST", body: {
      parent: { type: "page_id", page_id: rootId },
      icon: { type: "emoji", emoji: "🤖" },
      title: [{ type: "text", text: { content: "Задания бота — предлоги, условные, герундий" } }],
      description: [{ type: "text", text: { content: "Каждая строка — одно задание бота. В «Предложении» пропуск обозначай ___ (три подчёркивания). «Верный» — номер правильного варианта (1, 2 или 3). Сними галочку «Активно», чтобы задание не показывалось. После правок нажми в приложении «Пересобрать задания из Notion»." } }],
      properties: {
        [PROP.title]: { title: {} },
        [PROP.type]: { select: { options: GRAMMAR_TYPES.map(([, label], i) => ({ name: label, color: ["blue", "purple", "green", "orange"][i] })) } },
        [PROP.o1]: { rich_text: {} }, [PROP.o2]: { rich_text: {} }, [PROP.o3]: { rich_text: {} },
        [PROP.correct]: { number: { format: "number" } },
        [PROP.explain]: { rich_text: {} },
        [PROP.active]: { checkbox: {} },
      },
    } });
    dbId = nid(db.id);
    await store().setJSON("grammar:dbId", dbId);
    await appendLog(`база создана: ${db.url || dbId}`);
  } else await appendLog("база уже есть — добавляю недостающие задания");
  // что уже есть — не дублируем
  const existing = new Set(); let cursor;
  do { const d = await notion(`/databases/${dbId}/query`, { method: "POST", body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } }); for (const r of d.results || []) existing.add(txt((r.properties || {})[PROP.title])); cursor = d.has_more ? d.next_cursor : null; } while (cursor);
  let added = 0, total = 0;
  for (const [, label, list] of GRAMMAR_TYPES) {
    for (const it of list) {
      total += 1; if (existing.has(it.template)) continue;
      const rich = (s) => [{ type: "text", text: { content: String(s || "").slice(0, 1900) } }];
      await notion("/pages", { method: "POST", body: { parent: { database_id: dbId }, properties: {
        [PROP.title]: { title: rich(it.template) }, [PROP.type]: { select: { name: label } },
        [PROP.o1]: { rich_text: rich(it.options[0]) }, [PROP.o2]: { rich_text: rich(it.options[1]) }, [PROP.o3]: { rich_text: rich(it.options[2]) },
        [PROP.correct]: { number: it.correctIdx + 1 }, [PROP.explain]: { rich_text: rich(it.explain) }, [PROP.active]: { checkbox: true },
      } } });
      added += 1;
      if (added % 25 === 0) await appendLog(`добавлено ${added}…`);
    }
  }
  await setStatus({ status: "done", finishedAt: new Date().toISOString(), dbId, added, total });
  await appendLog(`готово: в базе ${total} заданий (добавлено ${added}). Редактируй в Notion, потом «Пересобрать задания из Notion».`);
}

export default async (req) => {
  let body = {};
  try { body = await req.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (secret && body.secret !== secret) return new Response("forbidden", { status: 403 });
  // Привязка списком: ставим привязки из списка Маргариты и дальше читаем учеников по очереди
  if (body.mode === "studentSeed") {
    const now = new Date().toISOString();
    await Promise.all(STUDENT_NOTION_SEED.map(async (row) => {
      const key = (k) => `stu:${row.chatId}:${k}`;
      try {
        const cur = await store().get(key("link"), { type: "json" });
        if (!cur || cur.pageId !== row.pageId) await store().setJSON(key("link"), { pageId: row.pageId, url: `https://www.notion.so/${row.pageId}`, by: String(body.by || ""), at: now, seed: true });
        await store().setJSON(key("status"), { status: "running", startedAt: now, updatedAt: now, log: ["в очереди…"] });
      } catch (e) { console.error("seed", row.chatId, e && e.message); }
    }));
    const ids = STUDENT_NOTION_SEED.map((r) => String(r.chatId));
    body = { ...body, mode: "student", chatId: ids[0], queue: ids.slice(1) };
  }
  if (body.mode === "taskDone") { try { await runTaskDone(body); } catch (e) { console.error("taskDone", e && e.message); } return new Response("ok", { status: 200 }); }
  if (body.mode === "lessonRemind") { try { await runLessonRemind(); } catch (e) { console.error("lessonRemind", e && e.message); } return new Response("ok", { status: 200 }); }
  if (body.mode === "student") {
    if (!process.env.NOTION_TOKEN) { await store().setJSON(`stu:${String(body.chatId || "")}:status`, { status: "error", error: "нет переменной NOTION_TOKEN в Netlify", updatedAt: new Date().toISOString() }); return new Response("no token", { status: 200 }); }
    // Очередь читаем в этом же запуске, пока укладываемся в 9 минут (лимит фоновой функции — 15).
    // Раньше каждый следующий ученик запускался отдельным запросом, и цепочка молча обрывалась после 8–9 учеников.
    const started = Date.now(); const BUDGET_MS = 9 * 60 * 1000;
    let rest = Array.isArray(body.queue) ? body.queue.map(String).filter((x) => /^\d{1,20}$/.test(x)).slice(0, 80) : [];
    let current = String(body.chatId || "");
    while (current) {
      try { await runStudent({ ...body, chatId: current }); } catch (e) { console.error("student", current, e && e.message); }
      if (!rest.length || Date.now() - started > BUDGET_MS) { current = ""; break; }
      current = rest.shift();
    }
    if (rest.length) {
      const base = (process.env.URL || "").replace(/\/+$/, "");
      let ok = false, last = "";
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try { const r = await fetch(`${base}/.netlify/functions/course-rebuild-background`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "student", chatId: rest[0], queue: rest.slice(1), secret: body.secret, by: body.by }) }); ok = r.ok; last = `HTTP ${r.status}`; }
        catch (e) { last = String((e && e.message) || e).slice(0, 80); }
        if (!ok) await new Promise((res) => setTimeout(res, 3000));
      }
      if (!ok) {
        console.error("student queue: не удалось продолжить", last);
        // хвост очереди сохраняем — часовая функция student-notion-sync заберет его первым
        try { await store().setJSON("stuqueue:rest", { ids: rest, at: new Date().toISOString(), error: last }); } catch (e) {}
        for (const id of rest) await store().setJSON(`stu:${id}:status`, { status: "error", error: `очередь оборвалась (${last}) — обновлю при следующем часовом запуске или нажми «Обновить»`, updatedAt: new Date().toISOString() });
      }
    }
    return new Response("ok", { status: 200 });
  }
  if (!process.env.NOTION_TOKEN) { await setStatus({ mode: body.mode, status: "error", error: "нет переменной NOTION_TOKEN в Netlify", finishedAt: new Date().toISOString() }); return new Response("no token", { status: 200 }); }
  try {
    if (body.mode === "course") await runCourse(body);
    else if (body.mode === "bizCourse") await runCourse({ ...body, track: "business" });
    else if (body.mode === "grammar") await runGrammar(body);
    else if (body.mode === "seedGrammar") await runSeedGrammar(body);
    else return new Response("bad mode", { status: 400 });
    return new Response("ok", { status: 200 });
  } catch (e) {
    const msg = String((e && e.message) || e);
    await setStatus({ status: "error", error: msg, finishedAt: new Date().toISOString() });
    await appendLog(`ошибка: ${msg}`);
    return new Response("error", { status: 200 });
  }
};
