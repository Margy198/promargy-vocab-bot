# Собирает data/interests/topics.mjs из data/interests/*.json (темы «Мои темы» вшиваются в бандл функции).
import json, glob, os
out = {}
for f in sorted(glob.glob('data/interests/*.json')):
    key = os.path.basename(f)[:-5]
    if key == 'index': continue
    d = json.load(open(f, encoding='utf-8'))
    if isinstance(d, dict) and 'sentences' in d: out[key] = d
js = "// Сгенерировано автоматически из data/interests/*.json — не редактировать руками (scripts/build-interests.py).\n// Темы «Мои темы» вшиты в бандл функции: на Netlify файлы через fs не находились, и лента была пустой.\nexport default " + json.dumps(out, ensure_ascii=False) + ";\n"
open('data/interests/topics.mjs', 'w', encoding='utf-8').write(js)
print(len(out), 'topics')
