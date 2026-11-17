// Домашние задания учеников из Notion пишутся в свободной форме: «Часть 1 … Ключи — часть 1»,
// «Упражнение 1 … ## Ответы» в конце, один общий тоггл «Ответы» и т.д. Курс же разбирается
// по строгому шаблону («## ✍️ Упражнения» → «### Упражнение N.» → тоггл «Ответы»).
// Этот модуль приводит страницу домашки к шаблону курса, чтобы дальше работали те же
// buildTopic и buildTopicDrills. Ответы берутся только из ключа на странице — ничего не придумываем.

const EX_RX = /^(#{1,3}\s+)?(<b>)?\s*(?:Часть|Упражнение|Задание|Exercise|Part|Task)\s+(\d+)\s*[.:)]?\s*(?:[—–-]\s*)?(.*)$/i;
const ANS_HEAD_RX = /^#{1,3}\s+(?:<b>)?\s*(?:Ответы|Ключи|Ключ|Answers|Answer key|Keys)(?![а-яёa-z])/i;
const ANS_TITLE_RX = /^(?:<b>)?\s*(?:Ответы|Ключи|Ключ|Answers|Answer key|Keys)(?![а-яёa-z])/i;
const NUM_IN_TITLE_RX = /(?:част[ьи]|упражнени[юяе]|задани[юяе]|exercise|part|task)\s*(\d+)/i;
const strip = (s) => String(s || "").replace(/<[^>]+>/g, "").trim();
const opens = (st) => st.startsWith("<toggle") || st.startsWith("<callout");
const closes = (st) => st === "</toggle>" || st === "</callout>";

// строки ключа: «1\. ответ<br />2. ответ» → отдельные нумерованные строки
function answerLines(lines) {
  const out = [];
  for (const raw of lines) for (const part of String(raw).split(/<br\s*\/?>/i)) {
    const t = part.replace(/^(\s*\d+)\\\./, "$1.").trimEnd();
    if (t.trim() === "---") continue;
    out.push(t);
  }
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
function exHeader(st) {
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
  const byN = (n) => exs.find((e) => e.n === n) || null;
  const pushAns = (target, lines) => { if (target) target.answers.push(...lines); else looseAns.push(...lines); };

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
    if (ANS_HEAD_RX.test(st)) { mode = "answers"; ansCur = null; continue; }
    const h = exHeader(st);
    if (mode === "answers") {
      if (h) { ansCur = byN(h.n); if (!ansCur) log.push(`в ответах есть «${strip(st).slice(0, 40)}», а такого упражнения нет`); if (h.extra) pushAns(ansCur, answerLines([h.extra])); continue; }
      pushAns(ansCur, answerLines([ln])); continue;
    }
    if (h) {
      if (byN(h.n)) log.push(`номер ${h.n} встречается дважды — второе упражнение пронумеровано по порядку`);
      cur = { n: byN(h.n) ? Math.max(...exs.map((e) => e.n)) + 1 : h.n, title: h.title, lines: h.extra ? [h.extra, ""] : [], answers: [] };
      exs.push(cur); mode = "ex"; continue;
    }
    if (mode === "ex" && cur) cur.lines.push(/^#{1,3}\s+/.test(st) ? `<b>${strip(st.replace(/^#{1,3}\s+/, ""))}</b>` : ln);
    else pre.push(ln);
  }

  // без заголовков «Часть/Упражнение»: одно упражнение — нумерованный список с ключом
  if (!exs.length && looseAns.some((l) => l.trim())) {
    const first = pre.findIndex((l) => /^\d+\.\s/.test(l.trim()));
    if (first >= 0) {
      let start = first; while (start > 0 && pre[start - 1].trim() && !/^#{1,4}\s/.test(pre[start - 1].trim())) start -= 1; // строка-задание перед списком
      exs.push({ n: 1, title: strip(pageTitle), lines: pre.splice(start), answers: looseAns.splice(0) });
    }
  }
  // ответы без подзаголовков: если упражнение одно без ключа — это его ключ
  if (looseAns.some((l) => l.trim())) {
    const empty = exs.filter((e) => !e.answers.some((l) => l.trim()));
    if (empty.length === 1) empty[0].answers.push(...looseAns);
    else if (exs.length) log.push("ответы не разбиты по упражнениям (нет подзаголовков «Часть N» / «Упражнение N») — часть ключа не привязана");
  }

  const out = [];
  const theory = pre.map((l) => { const st = l.trim(); return /^#{1,3}\s+/.test(st) ? `### ${strip(st.replace(/^#{1,3}\s+/, ""))}` : l; });
  if (strip(theory.join(" ")).replace(/[#\s]/g, "")) out.push("## 📖 Теория", "", ...theory, "");
  if (exs.length) {
    out.push("## ✍️ Упражнения", "");
    for (const e of exs) {
      out.push(`### Упражнение ${e.n}. ${e.title || "Задание"}`, "", ...e.lines, "");
      const gap = e.lines.some((l) => /\.\.\.|…|_{2,}/.test(l));
      if (e.answers.some((l) => l.trim())) out.push("<toggle>", "Ответы", "", ...e.answers.map((l) => markAnswer(l, gap)), "</toggle>", "");
      else log.push(`упражнение ${e.n} без ключа — в приложении оно будет только для чтения`);
    }
  }
  return { md: out.join("\n"), exercises: exs.length, withKey: exs.filter((e) => e.answers.some((l) => l.trim())).length, log };
}
