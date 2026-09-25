#!/usr/bin/env python3
"""
build_airtable_schema.py — снимок схемы Airtable (02-Sales, 03-Projects) для вкладки Dev Apps → Airtable.

Только СТРУКТУРА: таблицы и поля, без единой записи — поэтому снимок безопасно лежит в репо.
Источник — Airtable Metadata API (`GET /v0/meta/bases/<base>/tables`), нужен токен со scope
schema.bases:read. Токен в репо не попадает: скрипт читает уже сохранённые ответы API.

  # 1) выгрузить схему (токен — только в переменной окружения этой команды)
  for b in appiwOGVOMvQKbLp7 appucrtf5MBcFXVza; do
    curl -s -H "Authorization: Bearer $AIRTABLE_TOKEN" \\
      "https://api.airtable.com/v0/meta/bases/$b/tables" -o /tmp/airtable/$b.json
  done
  # 2) собрать снимок
  build_airtable_schema.py /tmp/airtable [--out src/data/airtable-schema.json]
"""
import argparse
import json
import os
import re
from datetime import datetime, timezone

BASES = [
    ('appiwOGVOMvQKbLp7', '02-Sales'),
    ('appucrtf5MBcFXVza', '03-Projects'),
]

# Ключевые таблицы: то, с чем работают Lead → Opportunity (Proposals) → Sale → Project.
CORE = {
    'tbl47L4i6HJpYv7BB': 'Lead',
    'tblpNpsfjW3YBhqY3': 'Opportunity — proposals',
    'tbl50Z1asdMX6NCUr': 'Sale (sales side)',
    'tblY5HQVxyDyR748b': 'Project',
    'tblIM2Ec6qPljFoe7': 'Project — finances',
    'tblJzgRjY2sfvLXmg': 'Sale (project side)',
}

COMPUTED = {'formula', 'rollup', 'multipleLookupValues', 'count', 'createdTime', 'lastModifiedTime',
            'autoNumber', 'createdBy', 'lastModifiedBy', 'button'}

# Эвристика «похоже на мусор»: копии, безымянные, временные, разовые офферы, опечатки.
JUNK = re.compile(r'\bcopy\b|^Field \d+$|disocunt|^temp\b|\btemp\b|\btest\b|june offer|march start|why not', re.I)


def build(src):
    tables_by_id, fields_by_id = {}, {}
    raw = {}
    for base_id, base_name in BASES:
        d = json.load(open(os.path.join(src, f'{base_id}.json')))
        if 'error' in d:
            raise SystemExit(f'{base_id}: {d["error"]}')
        raw[base_id] = d['tables']
        for t in d['tables']:
            tables_by_id[t['id']] = (base_id, base_name, t)
            for f in t['fields']:
                fields_by_id[f['id']] = (t['id'], f)

    def table_name(tid):
        return tables_by_id[tid][2]['name'] if tid in tables_by_id else tid

    def field_name(fid):
        return fields_by_id[fid][1]['name'] if fid in fields_by_id else fid

    def details(f):
        o = f.get('options') or {}
        t = f['type']
        if t == 'formula':
            # В формуле Airtable ссылается на поля по id ({fldXXX}) — подставляем имена.
            text = re.sub(r'\{(fld[A-Za-z0-9]+)\}', lambda m: '{' + field_name(m.group(1)) + '}', o.get('formula') or '')
            return {'formula': text, 'resultType': (o.get('result') or {}).get('type')}
        if t in ('singleSelect', 'multipleSelects'):
            return {'choices': [c.get('name') for c in o.get('choices') or []]}
        if t == 'multipleRecordLinks':
            tid = o.get('linkedTableId')
            return {'linksTo': f'{tables_by_id[tid][1]} / {table_name(tid)}' if tid in tables_by_id else tid,
                    'linkedTableId': tid}
        if t in ('multipleLookupValues', 'rollup', 'count'):
            via = o.get('recordLinkFieldId')
            target = o.get('fieldIdInLinkedTable')
            out = {'via': field_name(via) if via else None}
            if target:
                out['source'] = field_name(target)
            if t == 'rollup' and o.get('formula'):
                out['formula'] = re.sub(r'\{(fld[A-Za-z0-9]+)\}', lambda m: '{' + field_name(m.group(1)) + '}', o['formula'])
            return out
        if t == 'button':
            return {'label': o.get('label')}
        return {}

    bases = []
    for base_id, base_name in BASES:
        tables = []
        for t in raw[base_id]:
            fields = []
            for f in t['fields']:
                fields.append({
                    'id': f['id'],
                    'name': f['name'],
                    'type': f['type'],
                    'description': f.get('description') or None,
                    'computed': f['type'] in COMPUTED,
                    'primary': f['id'] == t['primaryFieldId'],
                    'junk': bool(JUNK.search(f['name'])),
                    **details(f),
                })
            tables.append({
                'id': t['id'],
                'name': t['name'],
                'role': CORE.get(t['id']),
                'description': t.get('description') or None,
                'fields': fields,
            })
        # Ключевые таблицы — первыми, в порядке цепочки; остальные — по имени.
        order = list(CORE)
        tables.sort(key=lambda x: (order.index(x['id']) if x['id'] in CORE else 99, x['name']))
        bases.append({'id': base_id, 'name': base_name, 'url': f'https://airtable.com/{base_id}', 'tables': tables})
    return {'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'bases': bases}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--out', default=os.path.join(here, '..', 'src', 'data', 'airtable-schema.json'))
    a = ap.parse_args()
    snap = build(a.src)
    with open(a.out, 'w') as f:
        json.dump(snap, f, ensure_ascii=False, indent=1)
    n_t = sum(len(b['tables']) for b in snap['bases'])
    n_f = sum(len(t['fields']) for b in snap['bases'] for t in b['tables'])
    print(f'{len(snap["bases"])} bases · {n_t} tables · {n_f} fields → {a.out}')


if __name__ == '__main__':
    main()
