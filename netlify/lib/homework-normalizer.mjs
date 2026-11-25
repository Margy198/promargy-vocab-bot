// Домашние задания учеников из Notion пишутся в свободной форме: «Часть 1 … Ключи — часть 1»,
// «Упражнение 1 … ## Ответы» в конце, один общий тоггл «Ответы», ответы простым текстом внизу и т.д. Курс же разбирается
// по строгому шаблону («## ✍️ Упражнения» → «### Упражнение N.» → тоггл «Ответы»).
// Этот модуль приводит страницу домашки к шаблону курса, чтобы дальше работали те же
// buildTopic и buildTopicDrills. Ответы берутся только из ключа на странице — ничего не придумываем.

const EX_RX = /^(#{1,3}\s+)?(<b>)?\s*(?:Часть|Упражнение|Упр\.?|Задание|Exercise|Ex\.|Part|Task)\s*(\d+)\s*[.:)]?\s*(?:[—–-]\s*)?(.*)$/i;
const ANS_TITLE_RX = /^(?:<b>)?\s*(?:Ответы|Ответ|Ключи|Ключ|Answers?|Answer key|Keys?)(?![а-яёa-z])/i;
const NUM_IN_TITLE_RX = /(?:част[ьи]|упражнени[юяеи]|упр\.?|задани[юяеи]|exercise|part|task)\s*(\d+)/i;
// Строка-метка ключа: заголовком, жирным или простым текстом. «Ответы», «Ответы:», «Ключи — часть 2»,
// «Ответы к упражнению 1», «Ответы: 1. too 2. very». Обычная фраза («Ответы запиши в тетрадь») меткой не считается.
const ANS_MARK_RX = /^(?:Ответы|Ответ|Ключи|Ключ|Answers?|Answer key|Keys?)(?:\s+(?:к|ко|для|to|for))?(?:\s*[—–-])?(?:\s*(?:упражнени[юяеи]|упр\.?|част[ьи]|задани[юяеи]|exercise|part|task)\s*(\d+))?\s*[:.]?\s*(.*)$/i;
function ansMark(st) {
  const m = stripTags(st.replace(/^#{1,3}\s+/, "")).match(ANS_MARK_RX); if (!m) return null;
  const rest = (m[2] || "").trim();
  if (rest && !/^\d{1,2}[.)]\s*\S/.test(rest)) return null;
  return { n: m[1] ? Number(m[1]) : null, inline: rest };
}
function stripTags(x) { return String(x || "").replace(/<[^>]+>/g, "").trim(); }
const strip = (s) => String(s || "").replace(/<[^>]+>/g, "").trim();
const opens = (st) => st.startsWith("<toggle") || st.startsWith("<callout");
const closes = (st) => st === "</toggle>" || st === "</callout>";

// строки ключа: «1\. ответ<br />2. ответ» → отдельные строки
function answerLines(lines) {
  const out = [];
  for (const raw of lines) for (const part of String(raw).split(/<br\s*\/?>/i)) {
    const t = part.replace(/^(\s*\d+)\\\./, "$1.").trimEnd();
    if (t.trim() === "---") continue;
    out.push(t);
  }
  return out;
}
// «1. too 2. very 3. too» в одну строку → три строки (только если номера идут подряд)
function splitInline(line) {
  const marks = [...String(line).matchAll(/(^|[\s;,])(\d{1,2})[.)]\s/g)].map((m) => ({ at: m.index + m[1].length, n: Number(m[2]) }));
  if (marks.length < 2 || !marks.every((m, i) => i === 0 || m.n === marks[i - 1].n + 1)) return [line];
  const out = []; if (marks[0].at > 0 && line.slice(0, marks[0].at).trim()) out.push(line.slice(0, marks[0].at).trim());
  marks.forEach((m, i) => out.push(line.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : line.length).trim().replace(/[;,]\s*$/, "")));
  return out;
}
// Приводим ключ к виду «N. ответ»: разворачиваем строку с несколькими ответами, «1)» → «1.»,
// а если ответы написаны без номеров, по одному на строке, — нумеруем по порядку.
function tidyAnswers(lines) {
  let out = [];
  for (const l of lines) { const am = ansMark(l.trim()); if (am && !am.inline) continue; out.push(...splitInline(l)); }
  out = out.map((l) => l.replace(/^(\s*\d{1,2})\)\s+/, "$1. "));
  const real = out.filter((l) => stripTags(l));
  if (real.length && !real.some((l) => /^\s*\d{1,2}\.\s/.test(l))) { let n = 0; out = out.map((l) => (stripTags(l) ? `${++n}. ${l.trim().replace(/^[-•*]\s+/, "")}` : l)); }
  return out;
}
// «N. ответ — пояснение по-русски» → «N. <b>ответ</b> (пояснение)»: так ключ читает сборщик заданий.
// gap — в упражнении есть пропуски: ответ короткий, пояснение всегда после первого тире.
const CYR = /[а-яё]/i;
function markAnswer(line, gap) {
  const m = String(line).match(/^(\s*\d+[.)]\s+)(.*)$/); if (!m) return line;
  const body = m[2].trim();
  if (/<b>|❌|✅/.test(body)) return line;
  if (/^(верно|ошибки нет|без ошибок|правильно|correct|no mistakes?)[.!]?$/i.test(strip(body))) return `${m[1]}✅ верно`;
  const cuts = [...body.matchAll(/\s[—–]\s/g)].map((x) => x.index);
  let at = -1;
  if (gap && cuts.length) at = cuts[0];
  else {
    for (const c of cuts) { const right = body.slice(c).replace(/^\s[—–]\s/, ""); const first = (right.match(/[A-Za-zА-Яа-яЁё]/) || [""])[0]; if (CYR.test(first)) { at = c; break; } }
    if (at < 0) for (const c of cuts.slice().reverse()) { const right = body.slice(c); if (CYR.test(right) && !CYR.test(body.slice(0, c))) { at = c; break; } }
  }
  if (at < 0) return CYR.test(body) ? line : `${m[1]}<b>${body}</b>`;
  const ans = body.slice(0, at).trim(); const note = body.slice(at).replace(/^\s[—–]\s/, "").trim().replace(/[()]/g, "");
  return ans ? `${m[1]}<b>${ans}</b> (${note})` : line;
}
// «<b>1.1. Выбери правильное чтение.</b>», «### 2.3 Найди ошибку», в ключах «<b>1.1.</b> роб / рю / …»
const DOT_RX = /^(#{1,3}\s+)?(<b>)?\s*(\d{1,2})\.(\d{1,2})\.?\s*(.*)$/;
const BLOCK_RX = /^#{1,3}\s+(?:БЛОК|Блок|Block|Раздел|Тема)\s*\d*[.:]?\s*(.*)$/i;
function exHeader(st) {
  const dm = st.match(DOT_RX);
  if (dm) {
    let rest = dm[5] || ""; let extra = "";
    if (dm[2]) { const b = rest.match(/^(.*?)<\/b>\s*(.*)$/); if (b) { rest = b[1]; extra = b[2]; } else if (/<\/b>/.test(rest)) rest = rest.replace(/<\/b>/, ""); }
    // «1.1.» без текста после жирного — это строка ключа; с текстом — заголовок упражнения
    return { n: null, label: `${dm[3]}.${dm[4]}`, title: strip(rest).replace(/[.:]\s*$/, ""), extra: extra.trim(), heading: !!dm[1], bold: !!dm[2] };
  }
  const m = st.match(EX_RX); if (!m) return null;
  // «1. Текст задания» внутри списка сюда не попадает: нужно слово «Часть/Упражнение…»
  let rest = m[4] || ""; let extra = "";
  if (m[2]) { const b = rest.match(/^(.*?)<\/b>\s*(.*)$/); if (b) { rest = b[1]; extra = b[2]; } }
  rest = rest.replace(/\s*\\?\{toggle=[^}]*\\?\}\s*$/, "");
  return { n: Number(m[3]), title: strip(rest).replace(/[.:]\s*$/, ""), extra: extra.trim(), heading: !!m[1], bold: !!m[2] };
}

export function normalizeHomework(body, pageTitle = "") {
  const src = String(body || "").split("\n");
  // страница уже в шаблоне курса — не трогаем
  if (src.some((l) => /^## (?:\S+\s+)?Упражнения\s*$/.test(l.trim())) && src.some((l) => /^### .*Упражнение\s+\d+/.test(l.trim()))) return { md: body, exercises: -1, withKey: -1, log: [] };

  const pre = []; const exs = []; const log = [];
  let mode = "pre"; let cur = null; let ansCur = null; const looseAns = [];
  // pend — ответы после метки «Ответы» без номера: пока не ясно, это ключ упражнения над ней или общий раздел внизу
  const PEND = {}; let pend = null;
  const byN = (n) => exs.find((e) => e.n === n) || null;
  const byH = (h) => (h.label ? exs.find((e) => e.label === h.label) || null : byN(h.n));
  let block = ""; // «## БЛОК 2. …» — правило, под которым идут упражнения 2.1, 2.2…
  const pushAns = (target, lines) => { if (target === PEND && pend) pend.lines.push(...lines); else if (target && target !== PEND) target.answers.push(...lines); else looseAns.push(...lines); };
  const flushPend = (toLoose) => { if (!pend) return; if (!toLoose && pend.after) pend.after.answers.push(...pend.lines); else looseAns.push(...pend.lines); pend = null; };

  for (let i = 0; i < src.length; i++) {
    const ln = src[i]; const st = ln.trim();
    if (opens(st)) {
      // собираем блок целиком
      let d = 1, k = i + 1; const inner = [];
      while (k < src.length) { const t = src[k].trim(); if (opens(t)) d += 1; if (closes(t)) { d -= 1; if (d === 0) break; } inner.push(src[k]); k += 1; }
      const ti = inner.findIndex((x) => x.trim()); const title = ti >= 0 ? inner[ti].trim() : ""; const bodyLines = ti >= 0 ? inner.slice(ti + 1) : [];
      const isToggle = st.startsWith("<toggle");
      if (isToggle && ANS_TITLE_RX.test(strip(title))) {
        const num = strip(title).match(NUM_IN_TITLE_RX);
        const subs = bodyLines.filter((x) => exHeader(x.trim()));
        if (num && byN(Number(num[1]))) pushAns(byN(Number(num[1])), answerLines(bodyLines));
        else if (subs.length) { let t = null; for (const bl of bodyLines) { const h = exHeader(bl.trim()); if (h) { t = byN(h.n); if (h.extra) pushAns(t, answerLines([h.extra])); continue; } pushAns(t, answerLines([bl])); } }
        else pushAns(mode === "answers" ? ansCur : cur, answerLines(bodyLines));
      } else if (mode === "pre") {
        // справка, памятка — в теорию отдельной страницей
        if (isToggle && title) { pre.push(`### ${strip(title)}`, "", ...bodyLines, ""); } else pre.push(...src.slice(i, k + 1));
      } else if (mode === "answers") pushAns(ansCur, answerLines(bodyLines));
      else if (cur) cur.lines.push(...src.slice(i, k + 1));
      i = k; continue;
    }
    if (st === "---") continue;
    const am = exs.length || pre.some((l) => /^\d+\.\s/.test(l.trim())) ? ansMark(st) : null;
    if (am) {
      flushPend(false); mode = "answers";
      if (am.n && byN(am.n)) ansCur = byN(am.n);
      else { pend = { after: cur, lines: [] }; ansCur = PEND; }
      if (am.inline) pushAns(ansCur, [am.inline]);
      continue;
    }
    const bm = st.match(BLOCK_RX);
    if (bm && mode !== "answers") { block = strip(bm[1]); if (mode === "pre" && !exs.length) continue; mode = "ex"; cur = null; continue; }
    const h = exHeader(st);
    if (mode === "answers") {
      // в ключах строка «<b>1.1.</b> роб / рю / …» → ответы упражнения 1.1 (несколько таких на одной строке через <br>)
      if (h && h.label) {
        for (const part of answerLines([ln])) { const ph = exHeader(part.trim()); const t = ph ? byH(ph) : null; if (ph && t) { ansCur = t; if (ph.extra) pushAns(t, [ph.extra]); } else pushAns(ansCur, [part]); }
        continue;
      }
      if (h && byH(h)) { flushPend(true); ansCur = byH(h); if (h.extra) pushAns(ansCur, answerLines([h.extra])); continue; } // подзаголовок в разделе ответов
      if (!h) { pushAns(ansCur, answerLines([ln])); continue; }
      flushPend(false); // дальше идет новое упражнение: ответы выше были ключом предыдущего
    }
    if (h && (!h.label || h.title)) {
      const n = h.label ? exs.length + 1 : (byN(h.n) ? Math.max(...exs.map((e) => e.n)) + 1 : h.n);
      cur = { n, label: h.label || null, title: h.label ? `${h.label}. ${h.title}` : h.title, lines: [], answers: [] };
      if (block) cur.lines.push(`<b>${block}</b>`, "");
      if (h.extra) cur.lines.push(h.extra, "");
      exs.push(cur); mode = "ex"; ansCur = null; continue;
    }
    if (mode === "ex" && cur) cur.lines.push(/^#{1,3}\s+/.test(st) ? `<b>${strip(st.replace(/^#{1,3}\s+/, ""))}</b>` : ln);
    else pre.push(ln);
  }
  flushPend(true);

  // без заголовков «Часть/Упражнение»: одно упражнение — нумерованный список с ключом
  if (!exs.length && looseAns.some((l) => l.trim())) {
    const first = pre.findIndex((l) => /^\d+\.\s/.test(l.trim()));
    if (first >= 0) {
      let start = first; while (start > 0 && pre[start - 1].trim() && !/^#{1,4}\s/.test(pre[start - 1].trim())) start -= 1; // строка-задание перед списком
      exs.push({ n: 1, title: strip(pageTitle), lines: pre.splice(start), answers: looseAns.splice(0) });
    }
  }
  // ответы без подзаголовков: одно упражнение без ключа — это его ключ; несколько — делим там, где нумерация начинается с 1
  if (looseAns.some((l) => l.trim())) {
    const empty = exs.filter((e) => !e.answers.some((l) => l.trim()));
    if (empty.length === 1) empty[0].answers.push(...looseAns);
    else if (empty.length > 1) {
      const chunks = []; let c = null;
      for (const l of tidyAnswers(looseAns)) { if (/^\s*1\.\s/.test(l) || !c) { c = []; chunks.push(c); } c.push(l); }
      const real = chunks.filter((x) => x.some((l) => strip(l)));
      if (real.length === empty.length) empty.forEach((e, i) => e.answers.push(...real[i]));
      else log.push("ответы не разбиты по упражнениям (нет подзаголовков «Часть N» / «Упражнение N») — ключ не привязан");
    }
  }

  // список через « / » (слова → чтение): «hisse / hippie / …» с ключом «ис / ипи / …» → нумерованные пункты;
  // ключ «роб / рю / …» к нумерованным пунктам → по одному ответу на пункт
  const slashParts = (l) => strip(l).split(/\s+\/\s+/).map((x) => x.trim()).filter(Boolean);
  for (const e of exs) {
    const items = e.lines.filter((l) => /^\d+\.\s/.test(l.trim()));
    const ansReal = e.answers.filter((l) => strip(l));
    if (ansReal.length === 1 && !/^\s*\d+[.)]\s/.test(ansReal[0])) {
      const parts = slashParts(ansReal[0].replace(/\s*\([^()]*\)\s*$/, ""));
      if (items.length >= 2 && parts.length === items.length) e.answers = parts.map((x, i) => `${i + 1}. ${x}`);
      else if (!items.length && parts.length >= 2) {
        const li = e.lines.findIndex((l) => strip(l) && !/^<b>/.test(l.trim()) && slashParts(l).length === parts.length);
        if (li >= 0) { const words = slashParts(e.lines[li]); e.lines.splice(li, 1, ...words.map((w, i) => `${i + 1}. ${w}`)); e.answers = parts.map((x, i) => `${i + 1}. ${x}`); }
        else {
          // «Выпиши только те слова, где …»: список слов, а в ключе — подмножество → по слову «да / нет»
          const lj = e.lines.findIndex((l) => strip(l) && !/^<b>/.test(l.trim()) && slashParts(l).length > parts.length);
          const words = lj >= 0 ? slashParts(e.lines[lj]) : [];
          const low = (x) => x.toLowerCase();
          if (words.length >= 3 && parts.every((p) => words.some((w) => low(w) === low(p)))) {
            const note = (ansReal[0].match(/\(([^()]*)\)\s*$/) || [])[1];
            e.lines.splice(lj, 1, ...words.map((w, i) => `${i + 1}. ${w} — да / нет`));
            e.answers = words.map((w, i) => `${i + 1}. ${parts.some((p) => low(p) === low(w)) ? "да" : "нет"}`);
            if (note) e.answers.push(`_${note}_`);
          }
        }
      }
    }
  }

  // «Распредели слова по группам»: список слов через « / », в ключе строки «(о) - au / eau: auto (ото), beau (бо), …»
  // → по слову выбор группы кнопками: «1. auto — (о) au, eau / (ё) eu / …»
  for (const e of exs) {
    if (e.lines.some((l) => /^\d+\.\s/.test(l.trim()))) continue;
    const li = e.lines.findIndex((l) => strip(l) && !/^<b>/.test(l.trim()) && slashParts(l).length >= 4);
    if (li < 0) continue;
    const words = slashParts(e.lines[li]);
    const low = (x) => x.toLowerCase().replace(/[.!?]+$/, "");
    const groups = [];
    for (const l of e.answers) {
      const m = strip(l).match(/^(.{1,40}?):\s*(.+)$/);
      if (!m) continue;
      const members = m[2].split(/\s*[,;]\s*|\s+\/\s+/).map((x) => x.replace(/\s*\([^()]*\)\s*/g, " ").trim()).filter(Boolean);
      if (members.length && members.every((w) => words.some((x) => low(x) === low(w)))) groups.push({ label: m[1].replace(/\s+\/\s+/g, ", ").replace(/\s+[—–-]\s+/, " "), members: members.map(low) });
    }
    if (groups.length < 2 || groups.length > 6) continue;
    const covered = words.filter((w) => groups.some((g) => g.members.includes(low(w))));
    if (covered.length < words.length * 0.8) continue;
    const labels = groups.map((g) => g.label);
    const tail = e.answers.filter((l) => strip(l) && !/^(.{1,40}?):\s*(.+)$/.test(strip(l)) && !/^\s*\d+[.)]\s/.test(l));
    e.lines.splice(li, 1, ...covered.map((w, i) => `${i + 1}. ${w} — ${labels.join(" / ")}`));
    e.answers = covered.map((w, i) => `${i + 1}. ${groups.find((g) => g.members.includes(low(w))).label}`).concat(tail.map((t) => `_${strip(t)}_`));
  }

  const out = [];
  const theory = pre.map((l) => { const st = l.trim(); return /^#{1,3}\s+/.test(st) ? `### ${strip(st.replace(/^#{1,3}\s+/, ""))}` : l; });
  if (strip(theory.join(" ")).replace(/[#\s]/g, "")) out.push("## 📖 Теория", "", ...theory, "");
  if (exs.length) {
    out.push("## ✍️ Упражнения", "");
    for (const e of exs) {
      out.push(`### Упражнение ${e.n}. ${e.title || "Задание"}`, "", ...e.lines, "");
      const gap = e.lines.some((l) => /\.\.\.|…|_{2,}/.test(l));
      if (e.answers.some((l) => l.trim())) out.push("<toggle>", "Ответы", "", ...tidyAnswers(e.answers).map((l) => markAnswer(l, gap)), "</toggle>", "");
      else log.push(`упражнение ${e.n} без ключа — в приложении оно будет только для чтения`);
    }
  }
  return { md: out.join("\n"), exercises: exs.length, withKey: exs.filter((e) => e.answers.some((l) => l.trim())).length, log };
}
