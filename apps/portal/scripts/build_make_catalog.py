#!/usr/bin/env python3
"""
build_make_catalog.py — снимок каталога писем и payload'ов сценариев Make для Dev Apps
(BAS-1556 письма, BAS-1504 payload'ы).

Make только ЧИТАЕМ: блюпринты выгружаются через MCP `scenarios_get` (ответы сохраняются в
файлы — они по 100–700 КБ), этот скрипт их разбирает и пишет src/data/make-catalog.json.
Портал в Make не ходит никогда.

  build_make_catalog.py <каталог с <scenarioId>.json> [--scope scripts/make-catalog-scope.json]
                        [--out src/data/make-catalog.json]

Что достаётся:
  • письма — модули отправки (Gmail, Email/SMTP, emailsender, QuickBooks SendInvoice): от кого,
    кому, CC/BCC, reply-to, тема, тело, вложения, и УСЛОВИЕ — все фильтры и маршруты роутера
    на пути к модулю, по-человечески;
  • payload — поля входного вебхука (metadata.interface триггера) и где каждое читается.
    Поле, переданное целиком (массив в итератор и т.п.), своих детей «неиспользуемыми» не делает.
"""
import argparse
import json
import os
import re
from datetime import datetime, timezone

ORG_ID = 10349  # BasementRemodeling.com, зона us1

EMAIL_MODULES = {
    'app#emailsender-vt4aje:sendEmail',
    'google-email:sendAnEmail',
    'google-email:ActionSendEmail',
    'email:ActionSendEmail',
    'quickbooks:SendInvoice',
}

OPS = {
    'exist': 'exists', 'notexist': 'does not exist',
    'text:equal': '=', 'text:notequal': '≠', 'text:equal:ci': '= (any case)', 'text:notequal:ci': '≠ (any case)',
    'text:contain': 'contains', 'text:notcontain': 'does not contain',
    'text:contain:ci': 'contains (any case)', 'text:notcontain:ci': 'does not contain (any case)',
    'text:startwith': 'starts with', 'text:endwith': 'ends with', 'text:pattern': 'matches',
    'number:equal': '=', 'number:notequal': '≠', 'number:greater': '>', 'number:less': '<',
    'number:greaterorequal': '≥', 'number:lessorequal': '≤',
    'boolean:equal': '=', 'boolean:notequal': '≠',
    'array:contain': 'contains', 'array:notcontain': 'does not contain',
    'date:greater': 'after', 'date:less': 'before',
}


def walk(flow, path=()):
    """Все модули с цепочкой предков-условий: (module, [ (label, filter) ... ])."""
    for m in flow:
        conds = list(path)
        if m.get('filter'):
            conds.append((m['filter'].get('name') or '', m['filter'].get('conditions') or []))
        yield m, conds
        for i, r in enumerate(m.get('routes') or []):
            yield from walk(r.get('flow', []), tuple(conds) + ((f'route {i + 1}', None),))
        if m.get('onerror'):
            yield from walk(m['onerror'], tuple(conds) + (('on error', None),))


def cond_text(conds):
    parts = []
    for label, groups in conds:
        if groups is None:
            continue  # маркер маршрута без собственного фильтра
        ors = []
        for group in groups:
            ands = []
            for c in group or []:
                op = OPS.get(c.get('o'), c.get('o'))
                b = c.get('b')
                ands.append(f"{c.get('a')} {op}" + (f' {b}' if b not in (None, '') and op not in ('exists', 'does not exist') else ''))
            if ands:
                ors.append(' and '.join(ands))
        if ors:
            body = ' or '.join(f'({o})' if len(ors) > 1 else o for o in ors)
            parts.append(f'«{label}»: {body}' if label else body)
    return '; '.join(parts) or None


def as_list(v):
    if v is None or v == '':
        return []
    if isinstance(v, list):
        out = []
        for x in v:
            out.extend(as_list(x) if not isinstance(x, dict) else [x.get('address') or x.get('email') or json.dumps(x)])
        return [s for s in out if s]
    return [s.strip() for s in str(v).split(',') if s.strip()] if '{{split' not in str(v) else [str(v)]


def email_entry(m, conds, label):
    mp = m.get('mapper') or {}
    t = m['module']
    conn = (m.get('parameters') or {}).get('__IMTCONN__') or (m.get('parameters') or {}).get('account')
    if t == 'app#emailsender-vt4aje:sendEmail':
        name, addr = mp.get('from_name'), mp.get('from_email')
        frm = f'{name} <{addr}>' if name and addr else (addr or name)
        return dict(to=as_list(mp.get('to_email')), cc=as_list(mp.get('cc')), bcc=as_list(mp.get('bcc')),
                    frm=frm, reply=mp.get('reply_to') or None, subject=mp.get('subject') or '',
                    body=mp.get('html') or mp.get('text') or '', att=attachments(mp))
    if t == 'google-email:sendAnEmail':
        return dict(to=as_list(mp.get('to')), cc=as_list(mp.get('cc')), bcc=as_list(mp.get('bcc')),
                    frm=mp.get('from') or (f'Gmail connection {conn}' if conn else None), reply=mp.get('replyTo') or None,
                    subject=mp.get('subject') or '', body=mp.get('content') or '', att=attachments(mp))
    if t == 'google-email:ActionSendEmail':
        return dict(to=as_list(mp.get('to')), cc=as_list(mp.get('cc')), bcc=as_list(mp.get('bcc')),
                    frm=mp.get('from') or (f'Gmail account {conn}' if conn else None), reply=mp.get('replyTo') or None,
                    subject=mp.get('subject') or '', body=mp.get('html') or mp.get('text') or '', att=attachments(mp))
    if t == 'email:ActionSendEmail':
        return dict(to=as_list(mp.get('to')), cc=as_list(mp.get('cc')), bcc=as_list(mp.get('bcc')),
                    frm=mp.get('from') or mp.get('sender') or (f'SMTP account {conn}' if conn else None),
                    reply=mp.get('replyTo') or None, subject=mp.get('subject') or '',
                    body=mp.get('html') or mp.get('text') or '', att=attachments(mp))
    if t == 'quickbooks:SendInvoice':
        return dict(to=as_list(mp.get('sendTo')) or ['(customer’s billing email in QuickBooks)'], cc=[], bcc=[],
                    frm='QuickBooks (company invoice email)', reply=None,
                    subject='(QuickBooks invoice email template)',
                    body=f'<p><i>QuickBooks sends invoice <b>{mp.get("id", "")}</b> with its own email template.</i></p>', att=['invoice PDF (QuickBooks)'])
    return None


def attachments(mp):
    out = []
    for a in mp.get('attachments') or []:
        if isinstance(a, dict):
            out.append(a.get('fileName') or a.get('filename') or a.get('name') or json.dumps(a)[:80])
        else:
            out.append(str(a))
    return out


def flatten_interface(items, prefix=''):
    """metadata.interface триггера → [(path, type, is_container)]."""
    out = []
    for it in items or []:
        name = it.get('name')
        if not name:
            continue
        path = f'{prefix}{name}'
        typ = it.get('type')
        spec = it.get('spec')
        container = typ in ('collection', 'array') and spec is not None
        out.append((path, typ, container))
        if typ == 'collection' and isinstance(spec, list):
            out.extend(flatten_interface(spec, path + '.'))
        elif typ == 'array' and spec is not None:
            inner = spec.get('spec') if isinstance(spec, dict) else spec
            if isinstance(inner, list):
                out.extend(flatten_interface(inner, path + '[].'))
    return out


def ref_forms(trigger_id, path):
    """Как путь выглядит внутри {{…}}: 1.a.b, 1.`a b`.c, 1.items[].x."""
    segs = path.replace('[]', '').split('.')
    def fmt(s):
        return f'`{s}`' if re.search(r'[^A-Za-z0-9_]', s) else s
    plain = f'{trigger_id}.' + '.'.join(segs)
    quoted = f'{trigger_id}.' + '.'.join(fmt(s) for s in segs)
    return {plain, quoted}


def texts_of(m):
    """(где, текст) для всего, что модуль читает: поля mapper и фильтр."""
    out = []
    def rec(prefix, v):
        if isinstance(v, str):
            out.append((prefix, v))
        elif isinstance(v, dict):
            for k, x in v.items():
                rec(f'{prefix}.{k}' if prefix else k, x)
        elif isinstance(v, list):
            for x in v:
                rec(prefix, x)
    rec('', m.get('mapper') or {})
    if m.get('filter'):
        rec('filter', m['filter'].get('conditions'))
    return out


def uses(text, forms):
    for f in forms:
        for m in re.finditer(re.escape(f), text):
            nxt = text[m.end():m.end() + 1]
            if nxt == '' or not re.match(r'[A-Za-z0-9_`]', nxt):
                return True
    return False


def build(src_dir, scope):
    scenarios = []
    for sid_str, meta in scope['scenarios'].items():
        sid = int(sid_str)
        path = os.path.join(src_dir, f'{sid}.json')
        if not os.path.exists(path):
            raise SystemExit(f'missing blueprint for {sid}: {path}')
        d = json.load(open(path))
        flow = d['blueprint']['flow']
        mods = list(walk(flow))
        label = lambda m: (m.get('metadata') or {}).get('designer', {}).get('name')

        emails = []
        for m, conds in mods:
            if m['module'] not in EMAIL_MODULES:
                continue
            e = email_entry(m, conds, label(m))
            if not e:
                continue
            emails.append({
                'moduleId': m['id'],
                'label': label(m),
                'module': m['module'],
                'condition': cond_text(conds),
                'from': e['frm'],
                'to': e['to'], 'cc': e['cc'], 'bcc': e['bcc'],
                'replyTo': e['reply'],
                'subject': e['subject'],
                'bodyHtml': e['body'],
                'attachments': e['att'],
            })

        webhook = None
        trig = next((m for m in flow if m['module'] == 'gateway:CustomWebHook'), None)
        if trig:
            md = trig.get('metadata') or {}
            hook_name = ((md.get('restore') or {}).get('hook') or {}).get('label')
            fields_raw = flatten_interface(md.get('interface') or [])
            fields = []
            for fpath, typ, container in fields_raw:
                forms = ref_forms(trig['id'], fpath)
                used = []
                for m, _ in mods:
                    if m is trig:
                        continue
                    for where, text in texts_of(m):
                        if '{{' in text and uses(text, forms):
                            used.append({'moduleId': m['id'], 'where': f"{label(m) or m['module']} · {where}"})
                            break
                fields.append({'path': fpath, 'type': typ, 'example': None, 'usedIn': used, 'container': container})
            # Поле, использованное целиком (контейнер ушёл в итератор/JSON), покрывает своих детей.
            for f in fields:
                if f['usedIn']:
                    continue
                parent = next((p for p in fields if p['usedIn'] and p['container'] and
                               (f['path'].startswith(p['path'] + '.') or f['path'].startswith(p['path'] + '[].'))), None)
                if parent:
                    f['usedIn'] = [{'moduleId': u['moduleId'], 'where': f"via {parent['path']} — {u['where']}"} for u in parent['usedIn'][:1]]
            webhook = {
                'name': hook_name,
                'fields': [{'path': f['path'], 'type': f['type'], 'example': None, 'usedIn': f['usedIn'],
                            'unused': not f['usedIn']} for f in fields],
            }

        scenarios.append({
            'id': sid,
            'name': d.get('name'),
            'stage': meta['stage'],
            'active': bool(d.get('isActive')),
            'url': f'https://us1.make.com/{ORG_ID}/scenarios/{sid}/edit',
            'webhook': webhook,
            'emails': emails,
        })
    return {'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'scenarios': scenarios}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--scope', default=os.path.join(here, 'make-catalog-scope.json'))
    ap.add_argument('--out', default=os.path.join(here, '..', 'src', 'data', 'make-catalog.json'))
    a = ap.parse_args()
    scope = json.load(open(a.scope))
    cat = build(a.src, scope)
    with open(a.out, 'w') as f:
        json.dump(cat, f, ensure_ascii=False, indent=1)
    n_e = sum(len(s['emails']) for s in cat['scenarios'])
    n_f = sum(len(s['webhook']['fields']) for s in cat['scenarios'] if s['webhook'])
    n_u = sum(sum(1 for x in s['webhook']['fields'] if x['unused']) for s in cat['scenarios'] if s['webhook'])
    print(f"{len(cat['scenarios'])} scenarios · {n_e} emails · {n_f} payload fields ({n_u} unused) → {a.out}")


if __name__ == '__main__':
    main()
