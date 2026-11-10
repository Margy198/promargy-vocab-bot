// Сборка контента курса из Notion — общий модуль для фоновой функции
// course-rebuild-background и локального скрипта. Это порт scripts/build-course.py
// на JS: тот же Notion-flavored Markdown на входе (как отдаёт Notion MCP «fetch»),
// тот же формат тем на выходе (data/course/topics/<id>.json).
//
// Плюс конвертер блоков официального Notion API (REST, /v1/blocks/:id/children)
// в этот же markdown — чтобы пересобирать курс прямо с сайта по кнопке.

// ---------- inline ----------
export function inline(s) {
  s = String(s || "").replace(/\\~/g, "~").replace(/\\_/g, "_").replace(/\\\*/g, "*").replace(/\\\[/g, "[").replace(/\\\]/g, "]");
  s = s.replace(/<br\s*\/?>/g, "<br>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/<(?!\/?(b|i|code|br|a|s|u)\b)/g, "&lt;");
  return s;
}
export function stripTags(s) { return String(s || "").replace(/<[^>]+>/g, ""); }

// ---------- block parser ----------
export function parseBlocks(lines) {
  const out = []; let i = 0; const n = lines.length; let para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const collect = (openRx, closeTag) => {
    let depth = 1, j = i + 1; const body = [];
    while (j < n) { const t = lines[j].trim(); if (openRx.test(t)) depth += 1; if (t === closeTag) { depth -= 1; if (depth === 0) break; } body.push(lines[j]); j += 1; }
    return { body, j };
  };
  while (i < n) {
    const ln = lines[i]; const st = ln.trim();
    if (!st) { flush(); i += 1; continue; }
    let m = st.match(/^<toggle(?:\s+heading="(h\d)")?>$/);
    if (m) {
      flush(); const { body, j } = collect(/^<toggle/, "</toggle>");
      let k = 0; while (k < body.length && !body[k].trim()) k += 1;
      const title = k < body.length ? inline(body[k].trim()) : "";
      out.push(`<details class="tg"><summary>${title}</summary><div class="tg-body">${parseBlocks(body.slice(k + 1))}</div></details>`);
      i = j + 1; continue;
    }
    m = st.match(/^<callout(?:\s+icon="([^"]*)")?(?:\s+color="([^"]*)")?>$/);
    if (m) {
      flush(); const { body, j } = collect(/^<callout/, "</callout>");
      let icon = m[1] || ""; if (icon.startsWith("/")) icon = "";
      out.push(`<div class="callout">${icon ? `<span class="ico">${icon}</span>` : ""}<div>${parseBlocks(body)}</div></div>`);
      i = j + 1; continue;
    }
    if (st.startsWith("<columns") || st.startsWith("</columns") || st.startsWith("<column") || st.startsWith("</column")) { flush(); i += 1; continue; }
    if (st.startsWith("<page ") || st === "</page>" || st.startsWith("<database") || st.startsWith("<embed") || st.startsWith("<p />") || st.startsWith("<p/>")) {
      flush();
      if (st.startsWith("<page ") && !st.endsWith("/>")) { while (i < n && lines[i].trim() !== "</page>") i += 1; }
      i += 1; continue;
    }
    if (st === "---" || st === "***") { flush(); out.push("<hr>"); i += 1; continue; }
    m = st.match(/^(#{1,6})\s+(.*)$/);
    if (m) { flush(); const lvl = Math.min(6, m[1].length + 1); out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); i += 1; continue; }
    if (st.startsWith(">")) {
      flush(); const buf = [];
      while (i < n && lines[i].trim().startsWith(">")) { buf.push(lines[i].trim().slice(1).trim()); i += 1; }
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue;
    }
    if (st.startsWith("|")) {
      flush(); let rows = [];
      while (i < n && lines[i].trim().startsWith("|")) { rows.push(lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())); i += 1; }
      rows = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
      if (rows.length) {
        const [head, ...body] = rows;
        let t = `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`;
        t += `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        out.push(`<div class="tbl">${t}</div>`);
      }
      continue;
    }
    if (/^- \[[ xX]\]\s/.test(st)) {
      flush(); const items = [];
      while (i < n && /^- \[[ xX]\]\s/.test(lines[i].trim())) { items.push(inline(lines[i].trim().slice(6))); i += 1; }
      out.push(`<ul class="check">${items.map((x) => `<li>${x}</li>`).join("")}</ul>`); continue;
    }
    if (/^[-*•]\s/.test(st)) {
      flush(); const items = [];
      while (i < n && /^[-*•]\s/.test(lines[i].trim())) { items.push(inline(lines[i].trim().slice(2))); i += 1; }
      out.push(`<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`); continue;
    }
    if (/^\d+[.)]\s/.test(st)) {
      flush(); const items = [];
      while (i < n && /^\d+[.)]\s/.test(lines[i].trim())) { items.push(inline(lines[i].trim().replace(/^\d+[.)]\s/, ""))); i += 1; }
      out.push(`<ol>${items.map((x) => `<li>${x}</li>`).join("")}</ol>`); continue;
    }
    if (st.startsWith("<table")) {
      flush(); let j = i; while (j < n && !lines[j].includes("</table>")) j += 1;
      out.push(`<div class="tbl">${lines.slice(i, j + 1).join("\n")}</div>`); i = j + 1; continue;
    }
    para.push(st); i += 1;
  }
  flush();
  return out.join("");
}

// ---------- topic ----------
const SECTION_KEYS = [
  ["why", /Зачем эт/], ["theory", /Теория/], ["native", /Как это видит носитель/], ["narrative", /Нарративные приемы/],
  ["examples", /Примеры с разбором/], ["pitfalls", /Подводные камни/], ["exercises", /Упражнения/],
  ["extra", /Дополнительные \d+ упражнени/], ["links", /Дополнительная практика/], ["selfcheck", /Самопроверка/],
];
export function sectionKey(title) { const t = stripTags(title); for (const [k, rx] of SECTION_KEYS) if (rx.test(t)) return k; return "other"; }
const ANSWER_RX = /Ответ|ответ|Answer|Ключ|Решени|Вариант/;

function splitTop(lines) {
  const sections = []; let cur = { title: "", lines: [] }; let depth = 0;
  for (const ln of lines) {
    const st = ln.trim();
    if (st.startsWith("<toggle") || st.startsWith("<callout")) depth += 1;
    else if (st === "</toggle>" || st === "</callout>") depth -= 1;
    if (depth === 0 && /^## /.test(st)) { sections.push(cur); cur = { title: st.slice(3).trim(), lines: [] }; }
    else cur.lines.push(ln);
  }
  sections.push(cur);
  return sections;
}
function unwrapPlainToggles(lines) {
  const out = []; const stack = []; let i = 0;
  while (i < lines.length) {
    const st = lines[i].trim();
    if (st.startsWith("<toggle")) {
      let plain = st === "<toggle>";
      let k = i + 1;
      if (plain) {
        while (k < lines.length && !lines[k].trim()) k += 1;
        const title = k < lines.length ? lines[k].trim() : "";
        if (ANSWER_RX.test(title)) plain = false;
      }
      stack.push(plain);
      if (plain) { i = k + 1; continue; }
    } else if (st === "</toggle>") {
      if (stack.length && stack.pop()) { i += 1; continue; }
    }
    out.push(lines[i]); i += 1;
  }
  return out;
}
function extractAnswers(body) {
  let ans = ""; const rest = []; let j = 0;
  while (j < body.length) {
    const st = body[j].trim();
    if (st.startsWith("<toggle")) {
      let k = j + 1, d = 1; const tb = [];
      while (k < body.length) { const t = body[k].trim(); if (t.startsWith("<toggle")) d += 1; if (t === "</toggle>") { d -= 1; if (d === 0) break; } tb.push(body[k]); k += 1; }
      const first = tb.find((x) => x.trim()) || "";
      if (ANSWER_RX.test(first)) ans += tb.includes(first) ? parseBlocks(tb.slice(tb.indexOf(first) + 1)) : parseBlocks(tb);
      else rest.push(...body.slice(j, k + 1));
      j = k + 1; continue;
    }
    rest.push(body[j]); j += 1;
  }
  return [rest, ans];
}
function parseExercises(linesIn, fallbackTitle = "") {
  const lines = unwrapPlainToggles(linesIn);
  if (!lines.some((l) => /^### /.test(l.trim()))) {
    const [rest, ans] = extractAnswers(lines); const html = parseBlocks(rest);
    return stripTags(html).trim() ? [{ n: 1, title: inline(fallbackTitle), html, answers: ans }] : [];
  }
  const ex = []; let cur = null, depth = 0, buf = [];
  const close = () => { if (cur) { const [rest, ans] = extractAnswers(buf.slice()); cur.html = parseBlocks(rest); cur.answers = ans; ex.push(cur); } };
  for (const ln of lines) {
    const st = ln.trim(); const m = st.match(/^### (.*)$/);
    if (m && depth === 0) {
      close(); buf = [];
      const title = m[1].trim(); const mm = stripTags(title).match(/Упражнение\s+(\d+)\.?\s*(.*)/);
      cur = { n: mm ? Number(mm[1]) : ex.length + 1, title: inline(mm ? mm[2] : title) };
      continue;
    }
    if (st.startsWith("<toggle") || st.startsWith("<callout")) depth += 1;
    else if (st === "</toggle>" || st === "</callout>") depth -= 1;
    if (cur) buf.push(ln);
  }
  close();
  return ex;
}
function parseSelfcheck(lines) {
  const items = lines.filter((l) => /^- \[[ xX]\]\s/.test(l.trim())).map((l) => inline(l.trim().slice(6)));
  const rest = lines.filter((l) => !/^- \[[ xX]\]\s/.test(l.trim()));
  return [items, parseBlocks(rest)];
}

// meta: { id, level, n, emoji, title, kind, description, contains }; body — markdown между <content> и </content>
export function buildTopic(meta, body) {
  const lines = body.split("\n");
  let k = 0; const pre = [];
  while (k < lines.length && !/^## /.test(lines[k].trim())) { pre.push(lines[k]); k += 1; }
  const intro = parseBlocks(pre.filter((l) => !/^\[← /.test(l.trim()) && l.trim() !== "---"));
  const secs = splitTop(lines.slice(k));
  const sections = []; const exercises = []; let selfcheck = [], selfcheckNote = "";
  for (const s of secs) {
    if (!s.title) continue;
    const key = sectionKey(s.title); const title = inline(s.title);
    if (key === "exercises" || key === "extra") {
      const hasH3 = unwrapPlainToggles(s.lines).some((l) => /^### /.test(l.trim()));
      const exs = parseExercises(s.lines, stripTags(s.title));
      if (hasH3) {
        const lead = []; for (const l of s.lines) { if (/^### /.test(l.trim())) break; lead.push(l); }
        if (key === "exercises" && stripTags(parseBlocks(lead)).trim()) sections.push({ key: "exercises_intro", title, html: parseBlocks(lead) });
      }
      exercises.push(...exs); continue;
    }
    if (key === "selfcheck") { [selfcheck, selfcheckNote] = parseSelfcheck(s.lines); continue; }
    sections.push({ key, title, html: parseBlocks(s.lines) });
  }
  for (const s of sections) if (s.key === "theory") {
    const pages = [];
    for (const p of s.html.split(/(?=<h4>)/)) {
      if (!p.trim()) continue;
      const m = p.match(/^<h4>(.*?)<\/h4>/);
      pages.push({ title: m ? stripTags(m[1]) : "", html: m ? p.slice(m[0].length) : p });
    }
    s.pages = pages;
  }
  return {
    id: meta.id, level: meta.level, n: meta.n, emoji: meta.emoji || "", title: meta.title, kind: meta.kind,
    description: meta.description || "", contains: meta.contains || "",
    intro, sections, exercises, selfcheck, selfcheckNote,
  };
}

// ---------- категории («Список тем» из макета Маргариты) ----------
export const CATEGORIES = [
  ["basics", "Основы", "алфавит и звуки, цифры, дни и месяцы, have got", [/Алфавит/i, /Цифры/i, /Дни, месяцы/i, /Have got/i]],
  ["tobe", "Глагол to be", "am / is / are, was / were, there is / there are, синонимы to be", [/To be/i, /There is/i, /Синонимы to be/i]],
  ["tenses", "Времена", "Pr.S., Pr.C., P.S., P.C., F.S., Pr.P., P.P., F.C., F.P., все 12 времён", [/Present Simple/i, /Present Continuous/i, /Past Simple/i, /Past Continuous/i, /Будущее/i, /Present Perfect/i, /Past Perfect/i, /Future Continuous/i, /Все 12 времен/i, /Stative/i, /narrative tenses/i, /would — все значения/i]],
  ["modals", "Модальные глаголы", "can, could, should, must, have to, may, might, модальные в прошлом", [/Can \/ can't/i, /Модальные/i, /may \/ might/i]],
  ["nouns", "Существительные", "множественное число, исчисляемые и неисчисляемые, some / any / much / many", [/Множественное число/i, /Some \/ any/i, /Исчисляемые/i]],
  ["articles", "Артикли", "a, an, the, отсутствие артикля, географические названия", [/Артикли/i]],
  ["pronouns", "Местоимения", "this / that / these / those, притяжательные, 's", [/This \/ that/i, /Притяжательный/i]],
  ["adjectives", "Прилагательные и наречия", "порядок прилагательных, степени сравнения", [/Порядок прилагательных/i, /Степени сравнения/i]],
  ["prepositions", "Предлоги", "времени, места, самые частоупотребимые предлоги", [/предлоги/i]],
  ["conditionals", "Условные предложения", "First, Second, Third, Mixed, wish / if only", [/Conditional/i, /wish \/ if only/i, /Mixed conditionals/i]],
  ["passive", "Пассивный залог", "введение, все времена, продвинутые формы", [/Passive/i]],
  ["reported", "Косвенная речь", "reported speech, reporting verbs, whether vs if", [/Reported Speech/i, /whether vs if/i]],
  ["verbals", "Герундий и инфинитив", "gerund vs infinitive, инфинитивные конструкции", [/Gerund/i, /Инфинитивные/i]],
  ["syntax", "Строение предложения", "повелительное наклонение, relative clauses, инверсия, cleft, причастные обороты", [/Повелительное/i, /Relative clauses/i, /Инверсия/i, /Cleft/i, /Participle/i, /Nominalisation/i, /Subjunctive/i, /Correlative/i]],
  ["vocab", "Лексика и стиль", "фразовые глаголы, словообразование, идиомы, linking words, регистр", [/Фразовые/i, /Phrasal/i, /Словообразование/i, /Idioms/i, /Linking words/i, /Discourse markers/i, /Hedging/i, /Register/i, /Лексика высокого/i, /Профессиональное/i, /аргументация/i]],
  ["bridges", "Мосты и экзамены", "переход между уровнями, экзамен-чекпоинты B2 и C1", []],
];
export function categoryOf(meta) {
  if (meta.kind !== "topic") return "bridges";
  for (const [key, , , pats] of CATEGORIES) for (const rx of pats) if (rx.test(meta.title)) return key;
  return "syntax";
}
export const HIDDEN = [/\(1\)$/];

// Один уровень: lv = { code, title, emoji, intro, checkpoint[], topics:[meta...] }, bodies: Map id -> markdown.
// Возвращает { record (запись уровня для индекса), topics: Map id -> topicJson, log[] }.
export function buildLevel(lv, bodies) {
  const list = []; const topics = new Map(); const log = [];
  for (const t0 of lv.topics) {
    const t = { ...t0, level: lv.code };
    if (HIDDEN.some((h) => h.test(t.title))) continue;
    t.category = categoryOf(t);
    const body = bodies.get(t.id);
    if (body == null) { log.push(`нет текста темы ${lv.code}-${t.n} «${t.title}»`); continue; }
    const tp = buildTopic(t, body);
    topics.set(tp.id, tp);
    list.push({ id: tp.id, n: t.n, level: lv.code, category: t.category, emoji: tp.emoji, title: tp.title, kind: tp.kind, description: tp.description, contains: tp.contains, sections: tp.sections.map((s) => s.key), exercises: tp.exercises.length, selfcheck: tp.selfcheck.length });
  }
  const record = { code: lv.code, title: lv.title, emoji: lv.emoji || "", intro: inline(lv.intro || ""), checkpoint: (lv.checkpoint || []).map(inline), topics: list };
  return { record, topics, log };
}
// Индекс из записей уровней (категории считаются заново по названиям тем).
export function assembleIndex(levelRecords, builtAt) {
  const catTopics = Object.fromEntries(CATEGORIES.map(([k]) => [k, []]));
  for (const lv of levelRecords) for (const t of lv.topics) { const c = t.category || categoryOf(t); t.category = c; (catTopics[c] || catTopics.syntax).push(t.id); }
  const categories = CATEGORIES.filter(([k]) => catTopics[k].length).map(([key, title, outline]) => ({ key, title, outline, topics: catTopics[key] }));
  return { levels: levelRecords, categories, builtAt: builtAt || new Date().toISOString().slice(0, 10) };
}
// Весь курс сразу (для локального скрипта и тестов).
export function buildCourse(levels, topicBodies, builtAt) {
  const records = []; const topics = new Map(); const log = [];
  for (const lv of levels) { const r = buildLevel(lv, topicBodies); records.push(r.record); for (const [k, v] of r.topics) topics.set(k, v); log.push(...r.log); }
  return { index: assembleIndex(records, builtAt), topics, log };
}

// Разбор страницы уровня (markdown): заголовок, intro (первая цитата), чекпоинт (- [ ] пункты),
// темы «## N. [emoji Title](url)» + <i>описание</i> + «<b>В теме:</b> …».
export function parseLevelPage(md) {
  const lines = md.split("\n");
  const topics = []; let intro = ""; const checkpoint = [];
  let cur = null; let seenCheck = false;
  for (const ln of lines) {
    const st = ln.trim();
    if (!intro && st.startsWith(">")) intro = st.slice(1).trim();
    const m = st.match(/^##\s+(\d+)\.\s+\[(.+?)\]\((?:https?:\/\/)?(?:www\.)?(?:app\.)?notion\.(?:so|com)\/(?:p\/)?(?:[^/)]*?)?([0-9a-f]{32})[^)]*\)/);
    if (m) {
      let title = m[2].trim(); let emoji = "";
      const em = title.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+/u);
      if (em) { emoji = em[1]; title = title.slice(em[0].length).trim(); }
      cur = { n: Number(m[1]), id: m[3], emoji, title: stripTags(title), description: "", contains: "", kind: "topic" };
      topics.push(cur); continue;
    }
    if (cur && st && !cur.description && /^<i>/.test(st)) { cur.description = stripTags(inline(st)).trim(); continue; }
    if (cur && /^<b>В теме[^<]*:<\/b>/.test(st)) { cur.contains = stripTags(inline(st.replace(/^<b>В теме[^<]*:<\/b>\s*/, ""))).trim(); cur = null; continue; }
    if (/Самопроверка|Чекпоинт|чекпоинт|Checkpoint/.test(st) && /^#/.test(st)) seenCheck = true;
    if (/^- \[[ xX]\]\s/.test(st)) { checkpoint.push(st.slice(6).trim()); seenCheck = true; }
  }
  return { intro, checkpoint, topics };
}

// ---------- Notion REST API → markdown ----------
function rt(arr) {
  return (arr || []).map((r) => {
    let t = r.plain_text || "";
    if (!t) return "";
    const a = r.annotations || {};
    t = t.replace(/</g, "&lt;");
    if (a.code) t = `<code>${t}</code>`;
    if (a.bold) t = `<b>${t}</b>`;
    if (a.italic) t = `<i>${t}</i>`;
    if (a.strikethrough) t = `<s>${t}</s>`;
    if (a.underline) t = `<u>${t}</u>`;
    const href = r.href || (r.text && r.text.link && r.text.link.url);
    if (href) t = `[${t}](${href})`;
    return t;
  }).join("").replace(/\n/g, "<br>");
}
function iconOf(icon) { if (!icon) return ""; if (icon.type === "emoji") return icon.emoji || ""; return ""; }
function pageIdFromUrl(u) { const m = String(u || "").match(/([0-9a-f]{32})(?:[?#]|$)/) || String(u || "").replace(/-/g, "").match(/([0-9a-f]{32})/); return m ? m[1] : null; }

// blocks: массив блоков с полем children (уже подгруженными рекурсивно).
// pageTitles: Map id -> {title, emoji} для child_page/link_to_page (чтобы выдать ссылку как в MCP-выгрузке).
export function blocksToMarkdown(blocks, pageTitles = new Map()) {
  const out = []; let num = 0;
  for (const b of blocks || []) {
    const type = b.type; const d = b[type] || {};
    if (type !== "numbered_list_item") num = 0;
    const kids = b.children && b.children.length ? blocksToMarkdown(b.children, pageTitles) : "";
    switch (type) {
      case "paragraph": { const t = rt(d.rich_text); out.push(t || ""); if (kids) out.push(kids); out.push(""); break; }
      case "heading_1": case "heading_2": case "heading_3": {
        const lvl = { heading_1: 1, heading_2: 2, heading_3: 3 }[type]; const t = rt(d.rich_text);
        if (d.is_toggleable) { out.push(`<toggle heading="h${lvl}">`, t, "", kids, "</toggle>", ""); }
        else out.push(`${"#".repeat(lvl)} ${t}`, "");
        break;
      }
      case "quote": out.push(`> ${rt(d.rich_text)}`); if (kids) out.push(kids); out.push(""); break;
      case "callout": out.push(`<callout icon="${iconOf(d.icon).replace(/"/g, "")}"${d.color ? ` color="${d.color}"` : ""}>`, rt(d.rich_text), "", kids, "</callout>", ""); break;
      case "toggle": out.push("<toggle>", rt(d.rich_text), "", kids, "</toggle>", ""); break;
      case "bulleted_list_item": out.push(`- ${rt(d.rich_text)}`); if (kids) out.push(kids.split("\n").map((l) => (l ? "  " + l : l)).join("\n")); break;
      case "numbered_list_item": num += 1; out.push(`${num}. ${rt(d.rich_text)}`); if (kids) out.push(kids.split("\n").map((l) => (l ? "  " + l : l)).join("\n")); break;
      case "to_do": out.push(`- [${d.checked ? "x" : " "}] ${rt(d.rich_text)}`); break;
      case "divider": out.push("---", ""); break;
      case "table": {
        const rows = (b.children || []).filter((r) => r.type === "table_row").map((r) => r.table_row.cells.map((c) => rt(c)));
        if (rows.length) { out.push(`| ${rows[0].join(" | ")} |`, `| ${rows[0].map(() => "---").join(" | ")} |`); for (const r of rows.slice(1)) out.push(`| ${r.join(" | ")} |`); out.push(""); }
        break;
      }
      case "column_list": out.push("<columns>", kids, "</columns>", ""); break;
      case "column": out.push("<column>", kids, "</column>"); break;
      case "child_page": { const p = pageTitles.get(b.id.replace(/-/g, "")) || {}; out.push(`<page url="https://www.notion.so/${b.id.replace(/-/g, "")}" title="${(d.title || p.title || "").replace(/"/g, "")}" />`, ""); break; }
      case "link_to_page": { const id = (d.page_id || d.database_id || "").replace(/-/g, ""); const p = pageTitles.get(id) || {}; out.push(`[${p.emoji ? p.emoji + " " : ""}${p.title || "страница"}](https://www.notion.so/${id})`, ""); break; }
      case "child_database": out.push(`<database url="https://www.notion.so/${b.id.replace(/-/g, "")}" inline="true"></database>`, ""); break;
      case "code": out.push(`<code>${(d.rich_text || []).map((r) => r.plain_text).join("").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</code>`, ""); break;
      case "bookmark": case "embed": case "link_preview": { const u = d.url || ""; if (u) out.push(`[${(d.caption && rt(d.caption)) || u}](${u})`, ""); break; }
      case "image": case "video": case "file": case "pdf": { const cap = d.caption && rt(d.caption); if (cap) out.push(cap, ""); break; }
      case "synced_block": if (kids) out.push(kids); break;
      case "table_of_contents": case "breadcrumb": case "equation": case "unsupported": case "template": break;
      default: { const t = d && d.rich_text ? rt(d.rich_text) : ""; if (t) out.push(t, ""); if (kids) out.push(kids); }
    }
  }
  return out.join("\n");
}
export { pageIdFromUrl };
