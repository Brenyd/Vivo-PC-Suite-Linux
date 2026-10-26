import json, os, struct, sys
src, out = sys.argv[1], sys.argv[2]
f = open(src, 'rb')
_, hsize, _, jlen = struct.unpack('<IIII', f.read(16))
header = json.loads(f.read(jlen))
base = 8 + hsize
n = 0
def walk(node, path):
    global n
    for name, e in node.get('files', {}).items():
        p = os.path.join(path, name)
        if 'files' in e:
            os.makedirs(p, exist_ok=True); walk(e, p)
        elif e.get('unpacked') or 'link' in e:
            continue
        else:
            f.seek(base + int(e['offset'])); os.makedirs(path, exist_ok=True)
            open(p, 'wb').write(f.read(e['size'])); n += 1
walk(header, out)
print(n, 'files')
