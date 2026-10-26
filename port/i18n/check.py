# validates a translated batch against its source: line count, {n} placeholders, html tags
import re, sys
zh = open(sys.argv[1], encoding='utf8').read().rstrip('\n').split('\n')
en = open(sys.argv[2], encoding='utf8').read().rstrip('\n').split('\n')
ok = True
if len(zh) != len(en):
    print(f'LINE COUNT {len(zh)} vs {len(en)}'); ok = False
for i, (a, b) in enumerate(zip(zh, en), 1):
    if b == '=': continue
    for pat in (r'\{\w*\}', r'</?[a-zA-Z][^>]*>', r'%[sd]', r'\$\{[^}]*\}'):
        if sorted(re.findall(pat, a)) != sorted(re.findall(pat, b)):
            print(f'{i}: placeholder mismatch {re.findall(pat, a)} vs {re.findall(pat, b)}\n   {a}\n   {b}'); ok = False
    if re.search(r'[㐀-鿿]', b) and 'vivo' not in b:
        print(f'{i}: still Chinese: {b}'); ok = False
print('OK' if ok else 'ISSUES', len(en))
