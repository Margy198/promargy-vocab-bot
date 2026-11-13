// Превращает упражнения Марго из Notion в интерактивные задания приложения.
//
// Главный принцип: правильный ответ ВСЕГДА берется из ее ключа. Ничего не придумывается.
// Неверные варианты бывают только трех видов:
//   1) ее собственные альтернативы из задания — «(was / were)», «(I work / I works)»;
//   2) заведомо неграмматичные формы того же слова — doesn't works, goed, more bigger, am live;
//      такая форма не может оказаться правильной ни в каком контексте;
//   3) другое время — ТОЛЬКО в упражнениях-сравнениях («Simple или Continuous», «vs»),
//      где выбор времени и есть суть задания, и только если в ключе нет пометки «оба / both».
// Если безопасных неверных вариантов не набирается, пункт становится заданием «собери из слов»
// (слова — из ее ответа) или «вспомни сам» (показать ее ответ). Пункт никогда не теряется.

// ---------- текст ----------
const ENT = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&nbsp;": " ", "&#39;": "'", "&quot;": '"', "&apos;": "'" };
export function htmlToText(h) {
  return String(h || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|amp|nbsp|#39|quot|apos);/g, (m) => ENT[m] || m)
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
// Безопасный минимальный HTML для показа: только b, i, br, code->пропуск
const BLANK = "…";
export function cleanHtml(h) {
  return String(h || "")
    .replace(/<code>\s*_{2,}\s*<\/code>/gi, `<span class="gap">${BLANK}</span>`)
    .replace(/_{3,}/g, `<span class="gap">${BLANK}</span>`)
    .replace(/<(?!\/?(b|i|br|span)\b)[^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
function norm(s) {
  return htmlToText(s).toLowerCase().replace(/[.!?;:,]+$/g, "").replace(/\s+/g, " ").trim();
}
const BLANK_RX = /<code>\s*_{2,}\s*<\/code>|_{3,}|\.{3}|…/g;
function countBlanks(html) { return (String(html).match(BLANK_RX) || []).length; }

// ---------- пункты задания и ключа ----------
// Возвращает массив html-пунктов в порядке номеров.
export function splitItems(html) {
  const h = String(html || "");
  // 1) нумерованные списки (все <ol> подряд)
  const ols = h.match(/<ol>[\s\S]*?<\/ol>/g);
  if (ols) {
    const items = [];
    for (const ol of ols) for (const m of ol.matchAll(/<li>([\s\S]*?)<\/li>/g)) items.push(m[1]);
    if (items.length >= 2) return items;
    // «1. can<br>2. can't<br>…» одним абзацем превращается в список из одного пункта
    if (items.length === 1 && /<br\s*\/?>\s*(<b>)?2[.)]\s/i.test(items[0])) {
      const lines = ("1. " + items[0]).split(/<br\s*\/?>/i).map((l) => l.trim()).filter(Boolean);
      const num = lines.filter((l) => /^(<b>)?\d+[.)]\s/.test(l));
      if (num.length >= 2) return num.map((l) => l.replace(/^(<b>)?\d+[.)]\s*(<\/b>)?\s*/, ""));
    }
  }
  // 2) абзацы, начинающиеся с номера
  const ps = [...h.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  const numbered = ps.filter((p) => /^\s*(<b>)?\d+[.)]\s/.test(p) && !/<br>\s*(<b>)?\d+[.)]\s/.test(p));
  if (numbered.length >= 2) return numbered.map((p) => p.replace(/^\s*(<b>)?\d+[.)]\s*(<\/b>)?\s*/, ""));
  // 3) один абзац с номерами через <br> (так в бизнес-плане: «1. reports<br>2. meet<br>…»)
  for (const p of ps) {
    const lines = p.split(/<br\s*\/?>/i).map((l) => l.trim()).filter(Boolean);
    const num = lines.filter((l) => /^(<b>)?\d+[.)]\\?\s/.test(l) || /^(<b>)?\d+\\?\.\s/.test(l));
    if (num.length >= 2 && num.length >= lines.length - 1) return num.map((l) => l.replace(/^(<b>)?\d+\\?[.)]\s*(<\/b>)?\s*/, ""));
  }
  return [];
}

// Разбор пункта ключа
export function parseKey(aHtml) {
  const raw = String(aHtml || "");
  const text = htmlToText(raw);
  const bolds = [...raw.matchAll(/<b>([\s\S]*?)<\/b>/g)].map((m) => htmlToText(m[1])).filter(Boolean);
  const out = { raw, text, bolds, main: null, fix: null, noError: false, both: false, note: "", alts: [] };
  out.both = /\b(оба|both)\b|тоже верно|также верно|тоже можно|оба варианта/i.test(text);
  // ❌ неверно → ✅ верно
  if (/❌/.test(raw) && /✅/.test(raw)) {
    const wrong = htmlToText(raw.split("❌")[1].split(/→|->/)[0]).replace(/^[\s:—-]+|[\s:—-]+$/g, "");
    const afterOk = raw.split("✅").slice(1).join("✅");
    // верный вариант — весь текст после ✅ без русских пояснений (жирным часто выделена только исправленная часть)
    let right = htmlToText(afterOk).replace(/\s*\((?=[^)]*[а-яё])[^()]*\)/gi, "").replace(/\s+[—–-]\s+(?=[^—–-]*[а-яё]).*$/i, "");
    if (/[а-яё]/i.test(right)) { const okBold = (afterOk.match(/<b>([\s\S]*?)<\/b>/) || [])[1]; right = htmlToText(okBold != null ? okBold : afterOk.split("(")[0]); }
    // «— Russia» в ключе = нулевой артикль: в самом предложении тире нет
    right = right.replace(/(^|\s)[—–]\s+(?=[A-Za-z])/g, "$1").replace(/^[\s:—-]+|[\s:—-]+$/g, "").replace(/\s+/g, " ").trim();
    const noteM = htmlToText(afterOk).match(/\(([^()]{3,})\)\s*$/);
    out.fix = { wrong, right };
    out.note = noteM ? noteM[1] : "";
    return out;
  }
  if (/✅/.test(raw) && !/❌/.test(raw) && /верно|ошибки нет|без ошибок|правильно|correct/i.test(text)) { out.noError = true; out.note = text.replace(/^✅\s*/, ""); return out; }
  let main = bolds.length ? bolds.join(" / ") : text;
  // пояснение в скобках после ответа: «studies (study → studies)», «work (привычка)»
  const afterBold = bolds.length ? htmlToText(raw.slice(raw.lastIndexOf("</b>") + 4)) : "";
  const nm = (afterBold || "").match(/\(([^()]{2,})\)/);
  if (nm) out.note = nm[1].trim();
  if (!bolds.length) { const m = text.match(/^(.*?)\s*\(([^()]{2,})\)\s*$/); if (m) { main = m[1]; out.note = m[2]; } }
  // альтернативы «(или X)», «(also X)»
  for (const m of text.matchAll(/\((?:или|also|тж\.?|тоже|также)[:\s]+([^()]+)\)/gi)) out.alts.push(m[1].trim());
  out.main = main.replace(/\s+/g, " ").trim();
  // Полный текст ключа без пояснений: «<b>Is the film</b> interesting?» → «Is the film interesting?»
  out.full = text.replace(/\s*\((?=[^)]*[а-яё])[^()]*\)/gi, "").replace(/\s*\((?:или|also|тж\.?|тоже|также)[^()]*\)/gi, "")
    .replace(/\s+[—–-]\s+(?=[^—–-]*[а-яё]).*$/i, "").replace(/\s+/g, " ").trim();
  return out;
}

// ---------- глагольные формы ----------
export const IRREG = { be: ["was", "been"], go: ["went", "gone"], have: ["had", "had"], do: ["did", "done"], make: ["made", "made"], take: ["took", "taken"], see: ["saw", "seen"], come: ["came", "come"], get: ["got", "got"], give: ["gave", "given"], write: ["wrote", "written"], read: ["read", "read"], eat: ["ate", "eaten"], drink: ["drank", "drunk"], buy: ["bought", "bought"], think: ["thought", "thought"], know: ["knew", "known"], say: ["said", "said"], tell: ["told", "told"], find: ["found", "found"], leave: ["left", "left"], meet: ["met", "met"], run: ["ran", "run"], sit: ["sat", "sat"], speak: ["spoke", "spoken"], swim: ["swam", "swum"], teach: ["taught", "taught"], win: ["won", "won"], begin: ["began", "begun"], sleep: ["slept", "slept"], feel: ["felt", "felt"], forget: ["forgot", "forgotten"], send: ["sent", "sent"], spend: ["spent", "spent"], pay: ["paid", "paid"], bring: ["brought", "brought"], catch: ["caught", "caught"], fly: ["flew", "flown"], drive: ["drove", "driven"], break: ["broke", "broken"], choose: ["chose", "chosen"], wear: ["wore", "worn"], lose: ["lost", "lost"], hear: ["heard", "heard"], keep: ["kept", "kept"], build: ["built", "built"], cost: ["cost", "cost"], cut: ["cut", "cut"], put: ["put", "put"], hit: ["hit", "hit"], let: ["let", "let"], hurt: ["hurt", "hurt"], understand: ["understood", "understood"], become: ["became", "become"], fall: ["fell", "fallen"], grow: ["grew", "grown"], draw: ["drew", "drawn"], throw: ["threw", "thrown"], ride: ["rode", "ridden"], rise: ["rose", "risen"], sing: ["sang", "sung"], ring: ["rang", "rung"], stand: ["stood", "stood"], sell: ["sold", "sold"], hold: ["held", "held"], lead: ["led", "led"], mean: ["meant", "meant"], wake: ["woke", "woken"], forgive: ["forgave", "forgiven"], shut: ["shut", "shut"], set: ["set", "set"], show: ["showed", "shown"], steal: ["stole", "stolen"], tear: ["tore", "torn"], light: ["lit", "lit"], feed: ["fed", "fed"], fight: ["fought", "fought"], lend: ["lent", "lent"], shine: ["shone", "shone"], dig: ["dug", "dug"], bite: ["bit", "bitten"], hide: ["hid", "hidden"], freeze: ["froze", "frozen"], blow: ["blew", "blown"], shake: ["shook", "shaken"], stick: ["stuck", "stuck"], strike: ["struck", "struck"], hang: ["hung", "hung"], quit: ["quit", "quit"], spread: ["spread", "spread"], bet: ["bet", "bet"], deal: ["dealt", "dealt"], lay: ["laid", "laid"], seek: ["sought", "sought"], bend: ["bent", "bent"], sweep: ["swept", "swept"], withdraw: ["withdrew", "withdrawn"], overcome: ["overcame", "overcome"], undertake: ["undertook", "undertaken"], arise: ["arose", "arisen"], forecast: ["forecast", "forecast"], foresee: ["foresaw", "foreseen"], mislead: ["misled", "misled"], oversee: ["oversaw", "overseen"], rethink: ["rethought", "rethought"], outdo: ["outdid", "outdone"], beat: ["beat", "beaten"], bear: ["bore", "borne"], hang_up: ["hung up", "hung up"], wind: ["wound", "wound"], sink: ["sank", "sunk"], shoot: ["shot", "shot"], slide: ["slid", "slid"], spit: ["spat", "spat"], stink: ["stank", "stunk"], swear: ["swore", "sworn"], tread: ["trod", "trodden"], weep: ["wept", "wept"], wring: ["wrung", "wrung"], grind: ["ground", "ground"], flee: ["fled", "fled"], forbid: ["forbade", "forbidden"], seek_: ["sought", "sought"] };
// глаголы, у которых правильная и неправильная форма обе в ходу — на них «ошибочные» формы не строим
const DUAL = new Set(["learn", "dream", "burn", "spell", "spill", "spoil", "smell", "leap", "lean", "kneel", "dwell", "wake", "light", "fit", "dive", "prove", "sow", "sew", "mow", "show", "hang", "get"]);
const VOWEL = /[aeiou]/;
function cvc(base) { return /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(base) && base.length <= 4; }
const DOUBLE_LONG = new Set(["begin", "prefer", "occur", "refer", "admit", "commit", "permit", "regret", "forget", "control", "transfer", "submit", "omit", "equip", "upset", "compel", "propel", "patrol", "deter", "infer", "incur", "recur", "expel", "acquit"]);
export function third(b) {
  if (b === "be") return "is";
  if (b === "have") return "has";
  if (/[^aeiou]y$/.test(b)) return b.slice(0, -1) + "ies";
  if (/(s|sh|ch|x|z|o)$/.test(b)) return b + "es";
  return b + "s";
}
export function ing(b) {
  if (b === "be") return "being";
  if (/ie$/.test(b)) return b.slice(0, -2) + "ying";
  if (/(ee|ye|oe)$/.test(b)) return b + "ing";
  if (/[^aeiou]e$/.test(b) || /ue$/.test(b)) return b.slice(0, -1) + "ing";
  if (cvc(b) || DOUBLE_LONG.has(b)) return b + b.slice(-1) + "ing";
  return b + "ing";
}
function regPast(b) {
  if (/e$/.test(b)) return b + "d";
  if (/[^aeiou]y$/.test(b)) return b.slice(0, -1) + "ied";
  if (cvc(b) || DOUBLE_LONG.has(b)) return b + b.slice(-1) + "ed";
  return b + "ed";
}
export function past(b) { return IRREG[b] ? IRREG[b][0] : regPast(b); }
export function pp(b) { return IRREG[b] ? IRREG[b][1] : regPast(b); }
// Ошибки, которые реально делают ученики (заведомо неграмматичные формы)
function badThird(b) {
  // только ошибки, которые реально делают: studys, watchs, gos
  const out = [];
  if (/[^aeiou]y$/.test(b)) out.push(b + "s");
  else if (/(s|sh|ch|x|z|o)$/.test(b) && !["be", "do", "go"].includes(b)) out.push(b + "s");
  else if (b === "go") out.push("gos");
  else if (b === "do") out.push("dos");
  return out.filter((x) => x !== third(b));
}
const NO_REG = new Set(["be", "have", "do"]);
function badPast(b) {
  if (DUAL.has(b) || NO_REG.has(b)) return [];
  const out = [];
  if (IRREG[b]) { out.push(regPast(b)); if (IRREG[b][1] !== IRREG[b][0] && !["read"].includes(b)) out.push(IRREG[b][1]); }
  else {
    if (/[^aeiou]y$/.test(b)) out.push(b + "ed");
    if (cvc(b) && !/[^aeiou]e$/.test(b)) out.push(b + "ed");
  }
  return out.filter((x) => x && x !== past(b));
}
function badPP(b) {
  if (DUAL.has(b) || NO_REG.has(b)) return [];
  const out = [];
  if (IRREG[b]) { if (IRREG[b][0] !== IRREG[b][1]) out.push(IRREG[b][0]); out.push(regPast(b)); }
  return out.filter((x) => x && x !== pp(b));
}
function badIng(b) {
  const out = [];
  const g = ing(b);
  if (/[^aeiou]e$/.test(b)) out.push(b + "ing");
  if (cvc(b) || DOUBLE_LONG.has(b)) out.push(b + "ing");
  if (/ie$/.test(b)) out.push(b + "ing", b.slice(0, -1) + "ing");
  return out.filter((x) => x !== g);
}

// По форме найти базовый глагол (нужно, когда подсказки нет)
const BASE_BY_FORM = (() => {
  const m = new Map();
  for (const [b, [p2, p3]] of Object.entries(IRREG)) { m.set(p2, b); m.set(p3, b); }
  return m;
})();
export function guessBase(word, hint) {
  const w = String(word || "").toLowerCase();
  const h = String(hint || "").toLowerCase().trim();
  if (h && /^[a-z]+$/.test(h)) return h;
  if (/^(am|is|are|was|were)$/.test(w)) return "be";
  if (BASE_BY_FORM.has(w)) return BASE_BY_FORM.get(w);
  return null;
}

// Подсказка в скобках после пропуска: «(work)», «(not / handle)», «(not have)», «(you / work)»
export function parseHint(qText) {
  const m = qText.match(/\(([^()]{1,40})\)/);
  if (!m) return null;
  const raw = m[1].trim();
  const parts = raw.split(/\s*\/\s*|\s+/).map((x) => x.toLowerCase()).filter(Boolean);
  const neg = parts.includes("not") || parts.includes("never");
  const words = parts.filter((p) => !["not", "never"].includes(p));
  return { raw, neg, words, verb: words.length ? words[words.length - 1] : null };
}
// Альтернативы в задании: «(was / were)», «(I work / I works)», «(a / an / the)»
export function parseChoices(qHtml) {
  const t = htmlToText(qHtml);
  const groups = [...t.matchAll(/\(([^()]*\/[^()]*)\)/g)].map((m) => m[1].split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean));
  const tail = t.match(/(?:→|->|:)\s*([A-Za-z' ]{1,25}(?:\s*\/\s*[A-Za-z' ]{1,25}){1,3})\s*\.?$/);
  if (tail) groups.push(tail[1].split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean));
  // «14 — (а) fourteen / (б) forty»
  const lab = t.split(/\(\s*[абвгabcd]\s*\)/).slice(1).map((x) => x.replace(/\s*\/\s*$/, "").replace(/\s*[.;,]\s*$/, "").trim()).filter(Boolean);
  if (lab.length >= 2) groups.push(lab);
  return groups.filter((g) => g.length >= 2 && g.length <= 5 && g.every((x) => x.length <= 40));
}

// ---------- неверные варианты для глагольного пропуска ----------
const BE_PRES = ["am", "is", "are"];
// глаголы, совпадающие с прилагательными: «is open», «is live», «is free» — грамматично, как ошибку не предлагаем
const ADJ_VERB = new Set(["open", "close", "clean", "clear", "dry", "empty", "free", "slow", "warm", "cool", "calm", "fit", "light", "dark", "fine", "quiet", "last", "mean", "right", "wrong", "better", "cheap", "complete", "correct", "separate", "direct", "double", "equal", "secure", "perfect", "present", "content", "live", "busy", "ready", "tidy", "smooth", "wet", "full", "near", "level", "even", "free", "lower", "narrow", "thin", "slim", "sound", "still", "steady", "true", "idle", "loose", "tight", "dirty", "fat", "brown", "black", "white", "green", "blue", "red", "yellow", "grey", "gray", "open", "own", "back", "round", "total", "average", "alert", "faint", "lean", "sharp", "short", "long", "rough", "humble", "blind", "deaf", "dull", "weary", "worry"]);
const SUBJ_BE = { i: "am", he: "is", she: "is", it: "is", we: "are", you: "are", they: "are" };
const BOTH_GER_INF = new Set(["like", "love", "hate", "prefer", "start", "begin", "continue", "intend", "bother", "propose"]);
// Возвращает список заведомо неверных вариантов (без правильного)
const MODALS = new Set(["will", "would", "can", "could", "must", "should", "may", "might", "shall", "ought", "need", "dare"]);
export function verbDistractors(correct, ctx) {
  const c = correct.toLowerCase().replace(/\s+/g, " ").trim();
  const hint = ctx.hint || {};
  if (hint.verb && MODALS.has(hint.verb)) return [];
  const before = (ctx.before || "").toLowerCase();
  const subjWord = (before.match(/([a-z']+)\s*$/) || [])[1] || "";
  const lastWord = (c.match(/([a-z]+)$/) || [])[1];
  const base = guessBase(null, hint.verb) || (lastWord ? guessBase(lastWord) : null) || null;
  const out = [];
  const add = (...xs) => { for (const x of xs) if (x && x.toLowerCase() !== c && !out.includes(x)) out.push(x); };
  let m;
  if ((m = c.match(/^(doesn't|does not) ([a-z]+)$/))) add(`don't ${m[2]}`, `doesn't ${third(m[2])}`);
  else if ((m = c.match(/^(don't|do not) ([a-z]+)$/))) add(`doesn't ${m[2]}`, `don't ${third(m[2])}`);
  else if ((m = c.match(/^(didn't|did not) ([a-z]+)$/))) add(`didn't ${past(m[2])}`, `don't ${past(m[2])}`);
  else if ((m = c.match(/^(am|is|are)( not|n't)? ([a-z]+ing)$/))) {
    const v = m[3]; const bb = base || v.replace(/ing$/, "");
    for (const b of BE_PRES) if (b !== m[1]) add(`${b}${m[2] || ""} ${v}`);
    add(`${m[1]}${m[2] || ""} ${base || bb}`);
  } else if ((m = c.match(/^(was|were)( not|n't)? ([a-z]+ing)$/))) {
    add(`${m[1] === "was" ? "were" : "was"}${m[2] || ""} ${m[3]}`);
    if (base) add(`${m[1]}${m[2] || ""} ${base}`);
  } else if ((m = c.match(/^(has|have)( not|n't)? (been [a-z]+ing)$/))) {
    add(`${m[1] === "has" ? "have" : "has"}${m[2] || ""} ${m[3]}`);
    if (base) add(`${m[1]}${m[2] || ""} been ${base}`);
  } else if ((m = c.match(/^(has|have)( not|n't)? ([a-z]+)$/))) {
    add(`${m[1] === "has" ? "have" : "has"}${m[2] || ""} ${m[3]}`);
    const b = base || guessBase(m[3]);
    if (b) for (const w of badPP(b)) add(`${m[1]}${m[2] || ""} ${w}`);
  } else if ((m = c.match(/^had( not|n't)? ([a-z]+)$/))) {
    const b = base || guessBase(m[2]);
    if (b) { for (const w of badPP(b)) add(`had${m[1] || ""} ${w}`); add(`had${m[1] || ""} ${b}`); }
  } else if ((m = c.match(/^(will|won't|will not) ([a-z]+)$/))) add(`${m[1]} ${third(m[2])}`, `${m[1]} to ${m[2]}`);
  else if ((m = c.match(/^would have ([a-z]+)$/))) { add(`would had ${m[1]}`); const b = base || guessBase(m[1]); if (b) for (const w of badPP(b)) add(`would have ${w}`); }
  else if ((m = c.match(/^would( not|n't)? ([a-z]+)$/))) add(`would${m[1] || ""} ${third(m[2])}`, `would${m[1] || ""} to ${m[2]}`);
  else if ((m = c.match(/^(is|are|was|were|has been|have been|had been|will be) ([a-z]+(ed|en|n|t))$/)) && base && pp(base) === m[2]) {
    // пассив: is made → is make, is maked («is clean», «is open» — прилагательные, не предлагаем)
    if (!ADJ_VERB.has(base)) add(`${m[1]} ${base}`); for (const w of badPP(base)) add(`${m[1]} ${w}`);
  } else if (base === "be" && c === "be") {
    // «that every form be signed»: «is signed» в британском тоже допустимо — не предлагаем
    add("being", "to be");
  } else if (base === "be" && /^(am|is|are|was|were)( not|n't)?$/.test(c)) {
    // to be: только согласование (am / is / are, was / were)
    const neg = (c.match(/( not|n't)$/) || [""])[0]; const b0 = c.replace(/( not|n't)$/, "");
    // «I wish it wasn't», «as though he was», «if I was» — разговорно допустимо; «What worries me are…» — тоже
    if (/^(was|were)$/.test(b0) && /\b(wish|if only|as if|as though|if|suppose|supposing|imagine|rather)\b/.test(before)) return [];
    if (/^\s*what\b/.test(before)) return [];
    const set = /^(am|is|are)$/.test(b0) ? BE_PRES : ["was", "were"];
    for (const x of set) if (x !== b0) add(x + (neg === "n't" && x === "am" ? " not" : neg));
  } else if (base === "have" && /^(has|have|had)$/.test(c)) {
    // только неверное согласование: «she has» верно в косвенной речи, «she have» — нет
    const s3 = /^(he|she|it)$/.test(subjWord) || (/^[a-z]+$/.test(subjWord) && !/^(i|you|we|they)$/.test(subjWord));
    if (c === "has") add("have"); else if (c === "have") add("has"); else if (subjWord) add(s3 ? "have" : "has");
  } else if (/^[a-z]+$/.test(c) && base) {
    // одно слово. Формы строим, только если место действительно глагольное:
    // перед пропуском есть подлежащее (местоимение / слово), а не начало предложения.
    const finite = !!subjWord && !/^(the|a|an|to|very|so|too|and|but|or|of|for|with|at|in|on)$/.test(subjWord);
    const clause = /\b(if|when|after|before|as soon as|until|unless|once|as long as|in case)\b[^,.;]*$/.test(before);
    if (c === third(base) && c !== base) {
      add(base, ...badThird(base));
      if (clause) add(`will ${base}`);
      else if (finite && !ADJ_VERB.has(base)) add(`is ${base}`);
    } else if (c === base && finite) {
      add(third(base));
      if (clause) add(`will ${base}`);
      else { const be = SUBJ_BE[subjWord]; if (be && !ADJ_VERB.has(base) && !/(can|could|will|would|should|must|might|may|to|do|does|did|don't|doesn't|didn't|let|make|help)$/.test(before.trim())) add(`${be} ${base}`); else if (!/(can|could|will|would|should|must|might|may|to|do|does|did|don't|doesn't|didn't|let|make|help)$/.test(before.trim())) add(ing(base)); }
    } else if (c === past(base) && c !== base) {
      add(...badPast(base));
      if (finite && !NO_REG.has(base) && c !== "did") add(`did ${c}`); // did went / did moved — заведомо неграмматично
      if (finite && SUBJ_BE[subjWord] && !ADJ_VERB.has(base) && !NO_REG.has(base)) add(`${/^(i|he|she|it)$/.test(subjWord) ? "was" : "were"} ${base}`);
    } else if (c === ing(base) && finite) { add(...badIng(base)); const gov = (before.match(/([a-z]+)\s*$/) || [])[1] || ""; if (!BOTH_GER_INF.has(gov)) add(`to ${base}`); }
    else if (c === pp(base) && c !== past(base)) add(...badPP(base));
  } else if ((m = c.match(/^to ([a-z]+)$/)) && base === m[1]) {
    const gov = (before.match(/([a-z]+)\s*$/) || [])[1] || "";
    if (!BOTH_GER_INF.has(gov)) add(ing(m[1]));
    add(`to ${third(m[1])}`, `to ${past(m[1])}`);
  }
  // «was made», «is built» — грамматичный пассив, не может быть ошибкой
  const PART = (w) => BASE_BY_FORM.has(w) || /ed$/.test(w);
  return out.filter((x) => {
    const mm = x.toLowerCase().match(/^(am|is|are|was|were|be|been|being|has been|have been|had been|will be)( not|n't)? ([a-z]+)$/);
    return !(mm && PART(mm[3]) && !/^(made|built)$/.test("") );
  });
}

// ---------- прилагательные: степени сравнения ----------
const ADJ_IRREG = { good: ["better", "the best"], bad: ["worse", "the worst"], far: ["further", "the furthest"], little: ["less", "the least"], much: ["more", "the most"], many: ["more", "the most"] };
export function adjDistractors(correct, hintWord) {
  const c = correct.toLowerCase().trim();
  const a = (hintWord || "").toLowerCase();
  const out = [];
  const add = (...xs) => { for (const x of xs) if (x && x !== c && !out.includes(x)) out.push(x); };
  if (!a || !/^[a-z]+$/.test(a)) return out;
  if (ADJ_IRREG[a]) { const [cmp, sup] = ADJ_IRREG[a]; if (c === cmp) add(`more ${a}`, `${a}er`, `more ${cmp}`); else if (c === sup) add(`the most ${a}`, `the ${a}est`, `the most ${sup.replace("the ", "")}`); return out; }
  const er = /e$/.test(a) ? a + "r" : a + "er"; const est = /e$/.test(a) ? a + "st" : a + "est";
  const own = (w) => w === er || w === est || /^[a-z]+(ier|iest|er|est)$/.test(w) && w.startsWith(a.replace(/y$/, "").slice(0, Math.max(2, a.length - 2)));
  if (c === `more ${a}`) add(er, `more ${er}`);
  else if (c === `the most ${a}`) add(`the ${est}`, `the most ${est}`);
  else if (/^[a-z]+$/.test(c) && /er$/.test(c) && own(c)) add(`more ${a}`, `more ${c}`);
  else if (/^the [a-z]+est$/.test(c) && own(c.replace("the ", ""))) add(`the most ${a}`, `the most ${c.replace("the ", "")}`);
  return out;
}

// ---------- плитки для «собери из слов» ----------
const TRAP_PAIRS = [["doesn't", "don't"], ["does", "do"], ["is", "are"], ["am", "is"], ["was", "were"], ["has", "have"], ["this", "these"], ["that", "those"], ["much", "many"], ["isn't", "aren't"], ["wasn't", "weren't"], ["hasn't", "haven't"]];
export function tokenize(sentence) {
  const s = String(sentence || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.*?)([.!?…]+)?$/);
  const body = m[1]; const end = m[2] || "";
  // отдельное тире (реплики диалога «— So do I.») плиткой не делаем
  return { tokens: body.split(" ").filter((t) => t && !/^[—–]$/.test(t)), end };
}
// ловушки для пропуска — только по словам самого пропуска (in → on/at, for → since …)
const GAP_SETS = [["in", "on", "at"], ["for", "since"], ["some", "any"], ["few", "little"], ["much", "many"], ["who", "which"], ["since", "for"]];
export function gapTraps(tiles) {
  const low = tiles.map((t) => t.toLowerCase().replace(/[,;:]$/, ""));
  const out = trapsFor(tiles);
  if (low.length <= 2) for (const g of GAP_SETS) for (const w of low) if (g.includes(w)) for (const x of g) if (x !== w && !low.includes(x)) out.push(tiles[0] === tiles[0].toLowerCase() ? x : x[0].toUpperCase() + x.slice(1));
  return [...new Set(out)];
}
export function trapsFor(tokens) {
  const low = tokens.map((t) => t.toLowerCase().replace(/[,;:]$/, ""));
  const set = new Set(low);
  const traps = [];
  for (const [a, b] of TRAP_PAIRS) {
    if (set.has(a) && !set.has(b)) traps.push(b);
    else if (set.has(b) && !set.has(a)) traps.push(a);
  }
  // глагол в 3 лице ↔ базовая форма: works → work (только если base тоже не встречается)
  for (const w of low) {
    for (const [b, [p2]] of Object.entries(IRREG)) {
      if (w === p2 && !DUAL.has(b) && !NO_REG.has(b) && !set.has(regPast(b)) && regPast(b) !== p2) { traps.push(regPast(b)); break; }
    }
  }
  return [...new Set(traps)].filter((t) => !set.has(t)).slice(0, 2);
}

// ---------- классификация пункта ----------
const TRANSLATE_RX = /перев/i;
// открытые задания: ответ у каждого свой, в ключе — пример
const OPEN_RX = /творческ|о себе|о своей|о своем|своими словами|о желаниях|ответь на вопрос|о детстве|о путешеств|расскажи|опиши свою|напиши \d|свой пример|придумай/i;
const ERROR_RX = /ошибк|исправ/i;
const CONTRAST_RX = /\bvs\b|\bили\b|\bor\b|сравни|разниц/i;
function isSentence(s) {
  const t = String(s || "").trim();
  if (!t || /[а-яё]/i.test(t) || /\s\/\s/.test(t) || /…|\.\.\./.test(t)) return false;
  const w = t.split(/\s+/); return w.length >= 3 && w.length <= 18;
}

function fillBlanks(qHtml, parts) {
  let i = 0;
  const words = (h) => htmlToText(h).toLowerCase().replace(/[.,!?;:]/g, " ").split(/\s+/).filter(Boolean);
  let html = String(qHtml).replace(BLANK_RX, (all, off, str) => {
    if (parts[i++] == null) return "…";
    // ключ повторяет слова вокруг пропуска («There is no juice left» для «There is … juice left») — убираем повтор
    let pw = String(parts[i - 1]).split(/\s+/).filter(Boolean);
    const before = words(str.slice(0, off)); const after = words(str.slice(off + all.length).split(BLANK_RX)[0]);
    const lw = (w) => w.toLowerCase().replace(/[.,!?;:]/g, "");
    for (let k = Math.min(before.length, pw.length - 1); k >= 1; k--) if (pw.slice(0, k).map(lw).join(" ") === before.slice(-k).join(" ")) { pw = pw.slice(k); break; }
    for (let k = Math.min(after.length, pw.length - 1); k >= 1; k--) if (pw.slice(-k).map(lw).join(" ") === after.slice(0, k).join(" ")) { pw = pw.slice(0, -k); break; }
    parts[i - 1] = pw.join(" ");
    return `\u0001${parts[i - 1]}\u0002`;
  });
  let t = htmlToText(html);
  // убираем подсказку в скобках сразу после заполненного места и пометки в скобках по-русски
  t = t.replace(/\u0002\s*\([^()]*\)/g, "\u0002").replace(/\s*\((?=[^)]*[а-яё])[^()]*\)\s*/gi, " ");
  t = t.replace(/[\u0001\u0002]/g, "").replace(/\s+/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
  t = t.replace(/(\w)\s+'(ve|s|m|re|ll|d|t)\b/gi, "$1'$2");
  t = t.replace(/\s+[—–-]\s+(?=[^—–-]*[а-яё]).*$/i, "").trim();
  if (/[а-яё]/i.test(t)) return null;
  if (parts.some((p) => /^[—–-]/.test(String(p).trim()))) return null;
  if (/\b(\w+)\s+\1\b/i.test(t) && !/\b(\w+)\s+\1\b/i.test(htmlToText(qHtml))) return null;
  return i === parts.length ? t : null;
}

// Один пункт → задание
// ---------- артикли: пропуски a / an / the / без артикля ----------
const ART_SHOW = (x) => (x === "—" ? "без артикля" : x);
const indefFor = (w) => (/^[aeiou]/i.test(w || "") ? "an" : "a");
function articleFlips(x, next) { const ind = indefFor(next); return x === "a" || x === "an" ? ["the", "—"] : x === "the" ? [ind, "—"] : ["the", ind]; }
function articleSetOf(ctx) {
  const t = String(ctx || "").toLowerCase().replace(/ё/g, "е");
  const hasA = /\ba\s*(?:\/|или|,)\s*an\b/.test(t); const hasThe = /\bthe\b/.test(t); const hasZero = /—|без артикля|прочерк|оставь пустым|или нет/.test(t);
  if (hasA && !hasThe && !hasZero) return ["a", "an"];
  if (hasA && hasThe && !hasZero) return ["a", "an", "the"];
  if (hasA && hasZero && !hasThe) return ["a", "an", "—"];
  if (hasThe && !hasA && (hasZero || /нужен ли/.test(t))) return ["the", "—"];
  return null;
}
export function articleChoice(qText, key, blanks, ctx) {
  const segs = qText.split(/…|\.{3}|_{3,}/);
  if (segs.length !== blanks + 1) return null;
  const keyText = (key.full || key.text || "").replace(/\s*\([^()]*\)/g, " ").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = (s, last) => { const ws = (s.match(/[A-Za-z'’]+/g) || []); return last ? ws[ws.length - 1] || "" : ws[0] || ""; };
  const fills = []; const nexts = []; let pos = 0;
  for (let g = 0; g < blanks; g++) {
    const prev = word(segs[g], true); const next = word(segs[g + 1], false);
    if (!next) return null;
    let m = null;
    for (const rx of [prev ? new RegExp(`\\b${esc(prev)}\\s+(?:(a|an|the)\\s+|[—–-]\\s*)?${esc(next)}\\b`, "i") : null, new RegExp(`(?:^|[\\s—–-])(?:(a|an|the)\\s+|[—–-]\\s*)?${esc(next)}\\b`, "i")]) {
      if (!rx) continue; const sub = keyText.slice(pos); const mm = sub.match(rx); if (mm) { m = mm; pos += mm.index + mm[0].length; break; }
    }
    if (!m) { if (blanks === 1 && /^(a|an|the)$/i.test((key.main || "").trim())) { fills.push(key.main.trim()); nexts.push(next); break; } return null; }
    fills.push(m[1] ? (g === 0 && !segs[0].trim() ? m[1] : m[1].toLowerCase()) : "—"); nexts.push(next);
  }
  if (!fills.some((f) => f !== "—") && blanks === 1 && !/[—–-]/.test(keyText) && !/без артикля|нулев|не нужен/i.test(key.text || "")) return null;
  const sentence = /[.!?]\s*$/.test(qText.replace(/\s*\([^()]*\)\s*$/, ""));
  const cap = (x, g) => (g === 0 && !segs[0].trim() && sentence && x !== "—" ? x[0].toUpperCase() + x.slice(1) : x);
  const show = (arr) => arr.map((x, g) => ART_SHOW(cap(x.toLowerCase() === x ? x : x.toLowerCase(), g))).join(" … ");
  const correct = fills.map((f) => f.toLowerCase());
  // какие артикли тренирует упражнение: «A или AN?», «the или —», «a / an / —» — варианты только из этого набора
  const set = articleSetOf(ctx);
  if (set && correct.some((c) => !set.includes(c))) return null;
  const flips = (x, next) => {
    if (!set) return articleFlips(x, next);
    const alt = set.filter((y) => y !== x);
    // a ↔ an — главный контраст, потом the, потом без артикля
    return alt.sort((p, q) => rank(x, p) - rank(x, q)).slice(0, 2);
  };
  const rank = (x, y) => ((x === "a" && y === "an") || (x === "an" && y === "a") ? 0 : y === "the" ? 1 : y === "—" ? 2 : 3);
  const opts = [correct];
  if (blanks === 1) for (const f of flips(correct[0], nexts[0])) opts.push([f]);
  else { const a = correct.slice(); a[0] = flips(a[0], nexts[0])[0]; opts.push(a); const b = correct.slice(); const L = blanks - 1; b[L] = flips(b[L], nexts[L])[0]; opts.push(b); }
  const out = []; for (const o of opts) { const t = show(o); if (!out.includes(t)) out.push(t); }
  return out.length >= 2 ? { options: out } : null;
}

const escHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function buildDrill(ex, i, qHtml, aHtml, meta) {
  const id = `${meta.topicId}:${ex.n}:${i}`;
  const task = htmlToText(ex.title).replace(/\s*\{[^}]*\}\s*$/, "");
  const key = parseKey(aHtml);
  const qText = htmlToText(qHtml);
  const base = { id, ex: ex.n, i, task, q: cleanHtml(qHtml), key: cleanHtml(aHtml), note: key.note || "" };
  const blanks = countBlanks(qHtml);
  if (OPEN_RX.test(task) && !/❌/.test(aHtml)) return { ...base, type: "recall", open: true };

  // 1) Исправь ошибку
  if (key.fix && key.fix.right) {
    const right = key.fix.right; const wrong = key.fix.wrong;
    const orig = qText.replace(/\s*\([^()]*[а-яё][^()]*\)\s*$/i, "").trim();
    // исправленное предложение = исходное, где неверный кусок заменен на верный
    let fixed = null;
    const splice = (k, len) => {
      // верный кусок в ключе бывает шире ошибки («until you will come» → «I'll wait until you come»): убираем повтор соседних слов
      const before = orig.slice(0, k), after = orig.slice(k + len);
      let rw = right.split(/\s+/);
      const isWord = (w) => /[A-Za-z0-9]/.test(w);
      const bw = before.trim().split(/\s+/).filter(isWord), aw = after.trim().split(/\s+/).filter(isWord);
      const lw = (w) => w.toLowerCase().replace(/[.,!?;:]+$/, "");
      for (let n = Math.min(bw.length, rw.length - 1); n >= 1; n--) if (rw.slice(0, n).map(lw).join(" ") === bw.slice(-n).map(lw).join(" ")) { rw = rw.slice(n); break; }
      for (let n = Math.min(aw.length, rw.length - 1); n >= 1; n--) if (rw.slice(-n).map(lw).join(" ") === aw.slice(0, n).map(lw).join(" ")) { rw = rw.slice(0, -n); break; }
      return (before + rw.join(" ") + after).replace(/\s+/g, " ").replace(/\s+([.,!?])/g, "$1").replace(/([,;])(\s*[,;])+/g, "$1").replace(/([.!?])\1+$/, "$1").trim();
    };
    // ключ — уже целое исправленное предложение (с перестановкой слов): берем его как есть
    const wcount = (x) => x.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
    if (/^[A-Z]/.test(right) && /[.!?]$/.test(right) && wcount(right) >= wcount(orig) - 1 && wcount(right) >= 3) fixed = right;
    else if (wrong && orig.includes(wrong)) fixed = splice(orig.indexOf(wrong), wrong.length);
    else if (wrong && orig.toLowerCase().includes(wrong.toLowerCase())) fixed = splice(orig.toLowerCase().indexOf(wrong.toLowerCase()), wrong.length);
    // несколько ошибок в пункте: «is engineer / the Germany» → «is an engineer from Germany» заменяет весь отрезок
    else if (wrong && /\s\/\s/.test(wrong)) {
      const parts = wrong.split(/\s*\/\s*/).filter(Boolean); const lo = orig.toLowerCase();
      const a = lo.indexOf(parts[0].toLowerCase()); const lastP = parts[parts.length - 1].toLowerCase(); const b = lo.indexOf(lastP, a);
      if (a >= 0 && b >= a) fixed = orig.slice(0, a) + right + orig.slice(b + lastP.length);
    }
    if (fixed && norm(fixed) !== norm(orig) && !/[а-яё]/i.test(fixed + orig)) {
      return { ...base, type: "choice", mode: "fix", options: [fixed, orig], correct: 0, src: "fix" };
    }
    // ключ — целое предложение: собрать его из слов
    if (/^[A-Z]/.test(right) && /[.!?]$/.test(right) && isSentence(right)) {
      const { tokens, end } = tokenize(right);
      return { ...base, type: "build", mode: "fix", answer: right, accept: [right], tiles: tokens, end, traps: trapsFor(tokens) };
    }
    if (wrong && right && norm(wrong) !== norm(right) && !/[а-яё]/i.test(right + wrong)) {
      return { ...base, type: "choice", mode: "fix", options: [right, wrong], correct: 0, src: "fix" };
    }
    return { ...base, type: "recall", mode: "fix" };
  }
  if (key.noError) return { ...base, type: "recall", mode: "fix" };
  if (!key.main) return { ...base, type: "recall" };
  // ключ вида «1990 → nineteen ninety», «14 — fourteen»: левая часть повторяет задание, ответ — правая
  {
    const qShort = norm(qText.replace(/\s*\([^()]*[а-яё][^()]*\)\s*$/i, ""));
    for (const src of [key.full, key.main]) {
      const m = String(src || "").match(/^(.+?)\s+(?:→|->|—|–)\s+(.+)$/);
      const qt = qText.trim(); const rest = qt.toLowerCase().startsWith(m ? m[1].toLowerCase() : "\u0000") ? qt.slice(m[1].length).trim() : null;
      if (m && norm(m[1]) && rest !== null && (rest === "" || /^[—–→-]|^\(/.test(rest)) && !/[а-яё]/i.test(m[2])) { key.main = m[2].trim(); key.full = m[2].trim(); key.bolds = [m[2].trim()]; break; }
    }
  }
  // транскрипция (/bʊk/) из плиток не собирается — только выбор из ее вариантов или «вспомни»
  const ipa = /\/[^\/\s]*[ɪʊæɑɒɔəʌɜʃʒθðŋː][^\/\s]*\//.test(key.main + " " + (key.full || ""));
  if (meta.articles && blanks >= 1 && blanks <= 3 && !key.both && !parseChoices(qHtml).length) {
    const art = articleChoice(qText, key, blanks, htmlToText(ex.title) + " " + htmlToText(ex.html).slice(0, 160) + (meta.geo ? " the или — " : ""));
    if (art) return { ...base, type: "choice", options: art.options, correct: 0, src: "art" };
  }
  const dashKey = /^(—|-|–|∅|0)$/.test(key.main.trim());
  if (dashKey && !meta.geo) return { ...base, type: "recall" };

  // 2) Ее альтернативы в задании
  // «a) Can you check this? b) Could you possibly check this?» + ключ «a — пояснение»
  {
    const lm = qText.match(/^(.*?)\s*\ba\)\s*(.+?)\s+b\)\s*(.+?)(?:\s+c\)\s*(.+?))?\s*$/);
    const kl = String(key.text || "").match(/^\s*([abc])\b\s*(?:[—–-]\s*(.*))?$/i);
    if (lm && kl) {
      const opts = [lm[2], lm[3], lm[4]].filter(Boolean).map((x) => x.trim());
      const k = "abc".indexOf(kl[1].toLowerCase());
      if (k < opts.length) return { ...base, q: escHtml(lm[1] || ""), note: kl[2] ? kl[2].trim() : base.note, type: "choice", options: opts, correct: k, src: "alt" };
    }
  }
  // условные обозначения из задания: «У — умение, В — возможность, П — просьба» + ключ «П»
  if (meta.leadText) {
    const legend = [...meta.leadText.matchAll(/(?:^|[\s,:;(])([А-ЯЁA-Z]{1,3})\s*[—–-]\s*([а-яёa-z][а-яёa-z -]{1,30}?)(?=\s*[,.;)]|\s*$)/g)].map((m) => [m[1], m[2].trim()]);
    const code = String(key.main || "").replace(/\s*\([^()]*\)\s*/g, "").trim();
    const k = legend.findIndex(([c]) => c === code);
    if (legend.length >= 2 && legend.length <= 5 && k >= 0) return { ...base, type: "choice", options: legend.map(([, w]) => w[0].toUpperCase() + w.slice(1)), correct: k, src: "legend" };
  }
  const groups = parseChoices(qHtml);
  // варианты из названия упражнения: «HIS или HER?», «ever или never», «who / which / where / whose»
  {
    const tt = task.replace(/[?!.]+$/, "").replace(/^[^A-Za-z]*?(?=[A-Za-z])/, "").trim();
    // «may/might/could или must или can't»: слитная группа через «/» — один вариант (равноценные или одна идея)
    const okTitle = /^[A-Za-z'/ ]+(?:\s*(?:\s\/\s|или|,)\s*[A-Za-z'/ ]+){1,4}$/.test(tt) && /\/|или/.test(tt);
    const pieces = okTitle ? tt.split(/\s+или\s+|\s+\/\s+|\s*,\s*/).map((x) => x.trim()).filter(Boolean) : [];
    const tg = pieces.length === 1 ? pieces[0].split("/").map((x) => [x.trim()]) : pieces.map((x) => x.split("/").map((y) => y.trim()));
    if (!groups.length && tg.length >= 2 && tg.length <= 5 && blanks === 1 && !key.both) {
      const ans = String(key.main || "").replace(/\s*\([^()]*\)\s*/g, "").replace(/[.!?]+$/, "").trim();
      const k = tg.findIndex((g) => g.some((x) => x.toLowerCase() === ans.toLowerCase()));
      if (k >= 0) {
        const capF = /^[A-Z]/.test(ans) && ans !== ans.toUpperCase();
        const fmt = (x) => { const l = x.toLowerCase(); return capF ? l[0].toUpperCase() + l.slice(1) : ans === ans.toLowerCase() ? l : x; };
        return { ...base, type: "choice", options: tg.map((g) => g.map(fmt).join(" / ")), correct: k, src: "alt" };
      }
    }
  }
  for (const g of groups) {
    let idx = g.findIndex((x) => norm(x) === norm(key.main) || norm(x) === norm(key.bolds[0] || ""));
    if (idx >= 0 && !key.both) return { ...base, type: "choice", options: g.map((x) => (/^[—–-]$/.test(x.trim()) ? "без артикля" : x)), correct: idx, src: "alt", q: cleanHtml(qHtml) };
  }

  if (ipa) return { ...base, type: "recall" };
  // артикли с географическими названиями: the или без артикля — выбор однозначный
  if (blanks === 1 && meta.geo && /^(the|—|-|–|∅|no article|без артикля)$/i.test(key.main.trim())) {
    const isThe = /^the$/i.test(key.main.trim());
    return { ...base, type: "choice", options: ["the", "без артикля"], correct: isThe ? 0 : 1, src: "geo" };
  }
  // 3) Пропуск с подсказкой → варианты-формы
  if (blanks === 1 && !key.both) {
    const ans = key.main.split(/\s*\/\s*/)[0].replace(/[.!?]$/, "").trim();
    const hint = parseHint(qText);
    const before = qText.split(/…|\.{3}|_{3,}/)[0] || "";
    let wrongs = []; let skipGen = false;
    // наречие от прилагательного в скобках: (slow) → slowly, (good) → well, (fast) → fast
    const hw = hint && hint.words && hint.words.length === 1 ? hint.words[0].toLowerCase() : "";
    const ADV_EXC = { good: "well", fast: "fast", hard: "hard", late: "late", early: "early" };
    const lyOf = (a) => (/[^aeiou]y$/.test(a) ? a.slice(0, -1) + "ily" : /le$/.test(a) ? a.slice(0, -1) + "y" : /ic$/.test(a) ? a + "ally" : a + "ly");
    if (hw && /^[a-z]+$/.test(hw) && (ADV_EXC[hw] === ans.toLowerCase() || lyOf(hw) === ans.toLowerCase())) {
      const opts = [ans, hw];
      if (ADV_EXC[hw] && hw !== "good" && hw !== "early") opts.push(hw + "ly"); // fastly, hardly, lately — частые ошибки
      if (hw === "good") opts.push("goodly");
      const cap = /^[A-Z]/.test(ans) ? (x) => x[0].toUpperCase() + x.slice(1) : (x) => x;
      const uniq = [...new Set(opts.map((x) => x.toLowerCase()))].map(cap);
      if (uniq.length >= 2) return { ...base, type: "choice", options: uniq, correct: 0, src: "gen", hint: hint.raw };
      skipGen = true; // early → early: честных неверных форм нет
    } else if (hw && meta.adverbs && /^[a-z]+$/.test(hw) && ans.toLowerCase() === hw && !ADV_EXC[hw]) {
      // прилагательное остается после связки: (calm) → calm, неверный вариант — наречие calmly
      return { ...base, type: "choice", options: [ans, lyOf(hw)], correct: 0, src: "gen", hint: hint.raw };
    }
    // разделительный вопрос: хвостик «aux(n't) + местоимение» → смена знака и чужой вспомогательный
    const TAG = ans.match(/^(won't|can't|shan't|do|does|did|is|are|am|was|were|have|has|had|will|would|can|could|shall|should|must)(n't)? (I|you|he|she|it|we|they|there)$/i);
    if (!skipGen && TAG && /,\s*(…|\.{3}|_{3,})\s*\?/.test(qText)) {
      let [, aux, neg, pr] = TAG; let a = aux.toLowerCase();
      if (/n't$/.test(a)) { neg = "n't"; a = { "won't": "will", "can't": "can", "shan't": "shall" }[a]; }
      const okSet = new Set([ans, ...key.alts, ...key.main.split(/\s*\/\s*/)].map(norm));
      const third = /^(he|she|it|there)$/i.test(pr); const isI = pr === "I";
      const NEGF = { will: "won't", shall: "shan't", am: "aren't", can: "can't" };
      const mk = (x, n) => (n ? (NEGF[x] || x + "n't") : x);
      const flip = neg ? (a === "are" && isI ? "am" : a) : mk(a, true);
      // чужой вспомогательный при верном согласовании: be ↔ do, have/will/can/should → do
      const beNow = isI ? "am" : third ? "is" : "are"; const doNow = third ? "does" : "do";
      const bePast = third || isI ? "was" : "were";
      const SW = { is: doNow, are: doNow, am: "do", was: "did", were: "did", do: beNow, does: beNow, did: bePast, have: "did", has: "did", had: "did", will: doNow, would: doNow, can: doNow, could: "did", should: doNow, must: doNow, shall: doNow };
      let sw = SW[a];
      let cands;
      if (/^let's\b/i.test(qText)) cands = ["do we", "don't we"];
      else cands = [`${flip} ${pr}`, `${sw === "am" && neg ? "aren't" : mk(sw, !!neg)} ${pr}`];
      // повелительное «Open the door, will you?»: won't you тоже возможен (приглашение) — не даем его как неверный
      const firstW = qText.replace(/^[^A-Za-z]+/, "").split(/\s/)[0].toLowerCase();
      if (/^will you$/i.test(ans) && !/^(don't|you|nobody|no|none|neither|never)$/.test(firstW)) cands = cands.map((w) => (/^won't you$/i.test(w) ? "don't you" : w));
      cands = [...new Set(cands)].filter((w) => !okSet.has(norm(w)) && norm(w) !== norm(ans));
      if (cands.length) return { ...base, type: "choice", options: [ans, ...cands], correct: 0, src: "tag" };
    }
    if (!skipGen && ans.split(" ").length <= 4 && /^[A-Za-z' ]+$/.test(ans)) {
      wrongs = verbDistractors(ans, { hint: hint || {}, before });
      if (wrongs.length < 2 && hint && hint.words.length === 1) wrongs = wrongs.concat(adjDistractors(ans, hint.words[0]));
      // не предлагать как ошибку то, что в ключе указано допустимым
      const okSet = new Set([ans, ...key.alts, ...key.main.split(/\s*\/\s*/)].map(norm));
      wrongs = wrongs.filter((w) => !okSet.has(norm(w)));
      // контраст времен — только в упражнениях-сравнениях
      if (meta.contrast && wrongs.length < 2 && hint && hint.verb) {
        const b = hint.verb; const c = ans.toLowerCase();
        const swap = { [third(b)]: `is ${ing(b)}`, [`is ${ing(b)}`]: third(b), [`are ${ing(b)}`]: b, [`am ${ing(b)}`]: b, [b]: `are ${ing(b)}`, [past(b)]: `was ${ing(b)}`, [`was ${ing(b)}`]: past(b), [`were ${ing(b)}`]: past(b) };
        if (swap[c] && !okSet.has(norm(swap[c]))) wrongs.unshift(swap[c]);
      }
    }
    // регистр как у правильного ответа (в начале предложения — с заглавной)
    if (/^[A-Z]/.test(ans)) wrongs = wrongs.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    wrongs = [...new Set(wrongs)].filter((w) => norm(w) !== norm(ans)).slice(0, 2);
    if (wrongs.length >= 1) {
      const opts = [ans, ...wrongs];
      return { ...base, type: "choice", options: opts, correct: 0, src: "gen", hint: hint ? hint.raw : "" };
    }
  }

  // 4) Пропуски, которые можно заполнить → «собери предложение»
  if (blanks >= 1) {
    const parts = blanks === 1 ? [key.main.split(/\s*\/\s*/)[0]] : key.main.split(/\s*\/\s*/);
    // «She cooks well. → She's good …» — заполняем только вторую половину
    const arrowSplit = String(qHtml).split(/→|-&gt;|->/);
    const target = arrowSplit.length === 2 && countBlanks(arrowSplit[1]) === blanks ? arrowSplit[1] : qHtml;
    const wholeTarget = blanks === 1 && /^\s*(<[^>]+>\s*)*(<code>\s*_{2,}\s*<\/code>|_{3,}|…|\.{3})(\s*<[^>]+>)*\s*[.!?]?\s*$/.test(target);
    if (wholeTarget && key.full && /^[A-Z]/.test(key.full) && /[.!?]$/.test(key.full) && isSentence(key.full)) {
      const { tokens, end } = tokenize(key.full);
      return { ...base, type: "build", mode: TRANSLATE_RX.test(task) ? "translate" : "transform", answer: key.full, accept: [key.full], tiles: tokens, end, traps: trapsFor(tokens) };
    }
    if (wholeTarget) { const ty = typeDrill(base, key, blanks); return ty || { ...base, type: "recall" }; }
    if (parts.length === blanks) {
      const gp = parts.map((p) => p.replace(/[.!?]$/, ""));
      const full = fillBlanks(target, gp);
      if (full && isSentence(full) && !/→/.test(full)) {
        // собираем только то, что стоит в пропусках; предложение целиком показывается после проверки
        const gapText = gp.join(" ").replace(/\s+/g, " ").trim();
        const tiles = gapText.split(" ").filter(Boolean);
        const okAlt = new Set([...(key.alts || []), ...String(key.main || "").split(/\s*\/\s*/)].map(norm));
        const traps = gapTraps(tiles).filter((w) => !tiles.map((x) => x.toLowerCase()).includes(w.toLowerCase()) && !okAlt.has(norm(w)) && !key.both);
        if (tiles.length >= 2 || traps.length >= 1) return { ...base, type: "build", mode: "fill", answer: gapText, accept: [gapText], full, tiles, end: "", traps: traps.slice(0, 3) };
        const ty = typeDrill(base, key, blanks); if (ty) return { ...ty, full };
        return { ...base, type: "recall", full };
      }
    }
  }

  // 5) Ответ — целое предложение (перевод, трансформация, вопрос): берем ключ целиком
  const fullKey = (key.full && key.full.length >= key.main.length ? key.full : key.main).replace(/\s*\([^()]*\)\s*$/, "").trim();
  const ansSentence = fullKey.split(/\s+\/\s+(?=[A-Z])/);
  const first = ansSentence[0].trim();
  const allComplete = ansSentence.length === 1 || ansSentence.every((x) => /[.!?]$/.test(x.trim()));
  if (allComplete && /[A-Za-z]/.test(first) && isSentence(first) && !/[а-яё]/i.test(first)) {
    const { tokens, end } = tokenize(first);
    const accept = ansSentence.map((s) => s.trim()).concat(key.alts);
    return { ...base, type: "build", mode: TRANSLATE_RX.test(task) ? "translate" : "transform", answer: first, accept, tiles: tokens, end, traps: trapsFor(tokens) };
  }
  if (blanks >= 1) { const ty = typeDrill(base, key, blanks); if (ty) return ty; }
  return { ...base, type: "recall" };
}
// Короткий ответ в пропуск — ученик печатает сам. Совпадение с любым вариантом из ключа = верно;
// иначе приложение показывает ключ и спрашивает, совпадает ли по смыслу (ответ никогда не врет).
function typeDrill(base, key, blanks) {
  if (blanks !== 1 || key.both && !/\//.test(key.main)) return null;
  const main = String(key.main || "").replace(/\b([A-Za-z]+)\((n't|s|es|ed|d)\)/g, "$1/$1$2").replace(/\s*\([^()]*\)\s*/g, " ").replace(/^[—–-]\s*|\s*[—–-]\s*$/g, "").trim();
  // «widely / generally» — варианты; «if/whether she has finished» — вариант внутри фразы
  const expand = (v) => { const m = v.match(/(\S+)\/(\S+)/); if (!m) return [v]; return [...expand(v.replace(m[0], m[1])), ...expand(v.replace(m[0], m[2]))]; };
  const variants = main.split(/\s+\/\s+|\s+или\s+/).flatMap((x) => (x.split(/\s+/).length > 1 ? expand(x) : x.split("/"))).map((x) => x.replace(/[.!?]$/, "").replace(/^-/, "").trim()).filter(Boolean).concat(key.alts || []);
  const eng = variants.filter((v) => /^['’]?[A-Za-z][A-Za-z'’ -]*$/.test(v) && v.split(/\s+/).length <= 4);
  if (!eng.length || eng.length !== variants.length) return null;
  return { ...base, type: "type", answer: eng[0], accept: [...new Set(eng)] };
}

// Диалог / связный текст с пропусками «____ (1)» и ключом-списком:
// каждый пропуск → отдельный пункт: строка диалога, где этот пропуск открыт,
// а остальные пропуски строки уже заполнены ответами из ключа.
const NUM_BLANK_RX = /(<code>\s*_{2,}\s*<\/code>|_{3,})\s*(?:<\/?i>\s*)*\(\s*(\d{1,2})\s*\)(?:\s*<\/i>)*/g;
export function splitNumberedBlanks(html, answers) {
  const lines = [...String(html || "").matchAll(/<(li|p)>([\s\S]*?)<\/\1>/g)].map((m) => m[2]);
  const keyMain = answers.map((a) => { const k = parseKey(a); return (k.main || "").split(/\s*\/\s*/)[0].replace(/^\s*(?:[A-Z][a-z]+day|the|on|in|at)\s+(?=\b)/, (x) => x); });
  const byNum = new Map();
  lines.forEach((line, li) => { for (const m of line.matchAll(NUM_BLANK_RX)) byNum.set(Number(m[2]), li); });
  if (byNum.size < 2 || byNum.size !== answers.length) return null;
  const out = [];
  for (let n = 1; n <= answers.length; n++) {
    if (!byNum.has(n)) return null;
    const line = lines[byNum.get(n)];
    const q = line.replace(NUM_BLANK_RX, (all, blank, k, off, str) => {
      const kk = Number(k);
      if (kk === n) return "<code>____</code>";
      const pk = parseKey(answers[kk - 1]);
      let fill = (pk.bolds[0] || pk.main || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
      // ключ «— London» / «a small flat», а слово уже стоит после пропуска: оставляем только недостающее
      const after = htmlToText(str.slice(off + all.length)).toLowerCase().split(/\s+/).filter(Boolean);
      let fw = fill.split(/\s+/);
      for (let cut = fw.length - 1; cut >= 0; cut--) { const tail = fw.slice(cut).map((w) => w.toLowerCase().replace(/[.,!?]$/, "")); if (tail.every((w, j) => (after[j] || "").replace(/[.,!?]$/, "") === w)) { fw = fw.slice(0, cut); break; } }
      fill = fw.join(" ").trim();
      if (/^[—–-]?$/.test(fill)) return "";
      return `<b>${fill}</b>`;
    }).replace(/\s+((?:<\/?(?:i|em|span)[^>]*>)*<b>['’])/g, "$1");
    // длинная строка (связный текст) → только предложение, где открыт пропуск
    let shown = q;
    if (htmlToText(q).split(" ").length > 22) {
      const parts = q.split(/(?<=[.!?])\s+(?=[A-Z<])/);
      const hit = parts.find((x) => /<code>____<\/code>/.test(x));
      if (hit) shown = hit;
    }
    out.push(shown);
  }
  return out;
}

// Все задания темы
export function buildTopicDrills(topic) {
  const drills = []; const leads = {};
  const stats = { items: 0, choice: 0, build: 0, type: 0, recall: 0, whole: 0, mismatch: 0 };
  for (const ex of topic.exercises || []) {
    let qs = splitItems(ex.html);
    const as = splitItems(ex.answers);
    if ((!qs.length || qs.length !== as.length) && as.length >= 2) {
      const nb = splitNumberedBlanks(ex.html, as);
      if (nb) qs = nb;
    }
    const meta = { topicId: topic.id, contrast: CONTRAST_RX.test(htmlToText(ex.title)), geo: /географ/i.test(topic.title || ""),
      adverbs: /наречи/i.test(topic.title || "") || /наречи/i.test(htmlToText(ex.title) + " " + htmlToText(ex.html).slice(0, 300)),
      articles: /артикл/i.test(topic.title || "") || /артикл|\ba\s*\/\s*an\b/i.test(htmlToText(ex.title) + " " + htmlToText(ex.html).slice(0, 300)) };
    if (!qs.length || !as.length) { stats.whole++; continue; }
    if (qs.length !== as.length) { stats.mismatch++; stats.whole++; continue; }
    // вводная часть упражнения (инструкция, текст про героя, банк слов) — показывается над каждым заданием,
    // иначе пункт вида «(Where) → …» нерешаем
    const cut = ex.html.search(/<ol[\s>]|<p>\s*(?:<[^>]+>)*\s*1\s*[.)]/);
    const lead = cleanHtml((cut > 0 ? ex.html.slice(0, cut) : "").replace(/<\/p>\s*<p>/g, "<br>"));
    if (htmlToText(lead).length > 3 && !qs.some((q) => lead.includes(q))) leads[ex.n] = lead;
    meta.leadText = htmlToText(lead);
    const start = drills.length;
    for (let i = 0; i < qs.length; i++) {
      // творческие пункты («Имя, возраст, где живет») без ответа — пропускаем
      if (!htmlToText(as[i])) continue;
      const d = buildDrill(ex, i, qs[i], as[i], meta);
      drills.push(d); stats.items++; stats[d.type]++;
    }
    // «Вставь to или оставь пустым (—)»: все ответы упражнения — одно слово или прочерк → выбор из двух
    {
      const own = drills.slice(start);
      const mains = own.map((d) => String(parseKey(d.key).main || "").replace(/\s*\([^()]*\)\s*/g, "").trim());
      const words = [...new Set(mains.filter((m) => !/^[—–-]$/.test(m)))];
      if (own.length >= 4 && words.length === 1 && /^[A-Za-z']+$/.test(words[0]) && mains.some((m) => /^[—–-]$/.test(m)) && own.every((d) => countBlanks(d.q) === 1)) {
        own.forEach((d, k) => { stats[d.type]--; Object.assign(d, { type: "choice", src: "dash", options: [words[0], "ничего не нужно"], correct: /^[—–-]$/.test(mains[k]) ? 1 : 0 }); delete d.answer; delete d.accept; stats.choice++; });
      }
    }
  }
  return { drills, leads, stats };
}
