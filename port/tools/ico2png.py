# Extracts the largest PNG image embedded in a Windows .ico file.  usage: ico2png.py in.ico out.png
import struct, sys
d = open(sys.argv[1], 'rb').read()
best = None
for i in range(struct.unpack('<HHH', d[:6])[2]):
    w, h, _, _, _, _, size, off = struct.unpack('<BBBBHHII', d[6 + 16 * i:22 + 16 * i])
    if d[off:off + 4] == b'\x89PNG' and (best is None or (w or 256) > best[0]):
        best = (w or 256, d[off:off + size])
if not best:
    sys.exit('no PNG image inside ' + sys.argv[1])
open(sys.argv[2], 'wb').write(best[1])
