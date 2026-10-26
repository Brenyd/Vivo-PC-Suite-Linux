#!/usr/bin/env python3
"""vivo-phonefs: mount an Android phone's storage as a folder, over adb, using FUSE 3.

Linux replacement for vivo PC Suite's "phone as a drive" component (vdfs.exe + Dokan).
No extra packages: only Python's ctypes, libfuse3 and adb.

    vivo-phonefs.py MOUNTPOINT [--serial SERIAL] [--root /sdcard] [-f]
    fusermount3 -u MOUNTPOINT      # unmount

Reads are fetched on demand in 1 MiB chunks (so thumbnails and previews are fast);
written files are staged locally and pushed to the phone when closed.
"""
import argparse, ctypes, ctypes.util, errno, hashlib, os, posixpath, shlex, stat as S
import subprocess, sys, tempfile, threading, time

CHUNK = 1 << 20

# ----------------------------------------------------------------------------- adb backend
class Adb:
    def __init__(self, serial=None, adb=None):
        self.adb = adb or os.environ.get('PCSUITE_ADB') or 'adb'
        self.base = [self.adb] + (['-s', serial] if serial else [])

    def run(self, args, timeout=120, input=None):
        p = subprocess.run(self.base + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, input=input)
        return p.returncode, p.stdout, p.stderr

    def shell(self, cmd, timeout=120):
        rc, out, err = self.run(['shell', cmd], timeout)
        return rc, out.decode('utf-8', 'replace'), err.decode('utf-8', 'replace')

    @staticmethod
    def parse_stat(out):
        res = {}
        for line in out.splitlines():
            parts = line.split('/', 3)
            if len(parts) != 4:
                continue
            try:
                mode, size, mtime = int(parts[0], 16), int(parts[1]), int(parts[2])
            except ValueError:
                continue
            name = parts[3].rstrip('/').rsplit('/', 1)[-1]
            if name not in ('', '.', '..'):
                res[name] = (mode, size, mtime)
        return res

    def listdir(self, path):
        start = path.rstrip('/') + '/'
        rc, out, _ = self.shell(f"cd {shlex.quote(start)} || exit 3; find {shlex.quote(start)} -mindepth 1 -maxdepth 1 "
                                f"-exec stat -L -c '%f/%s/%Y/%n' {{}} + 2>/dev/null; true")
        if rc == 3:
            return None
        return self.parse_stat(out)

    def stat(self, path):
        rc, out, _ = self.shell(f"stat -L -c '%f/%s/%Y/%n' {shlex.quote(path)} 2>/dev/null")
        r = self.parse_stat(out)
        return next(iter(r.values())) if r else None

    def read_range(self, path, first_chunk, count):
        cmd = f"dd if={shlex.quote(path)} bs={CHUNK} skip={first_chunk} count={count} 2>/dev/null"
        rc, out, _ = self.run(['exec-out', cmd], timeout=600)
        return out

    def ok(self, cmd):
        rc, out, err = self.shell(cmd + '; echo "RC=$?"')
        tail = out.strip().rsplit('RC=', 1)
        return len(tail) == 2 and tail[1].strip() == '0'

# ----------------------------------------------------------------------------- filesystem logic
class PhoneFS:
    def __init__(self, adb, root, cache_dir):
        self.adb, self.root, self.cache_dir = adb, root.rstrip('/') or '/', cache_dir
        self.lock = threading.RLock()
        self.dirs = {}       # remote dir -> (time, {name: (mode,size,mtime)})
        self.chunks = {}     # remote path -> (key, set(chunk ids))
        self.writes = {}     # remote path -> [local temp path, refcount, dirty]
        self.ttl = 5.0
        os.makedirs(cache_dir, exist_ok=True)

    def rp(self, path):
        return posixpath.normpath(self.root + '/' + path.lstrip('/')) if path != '/' else self.root

    def invalidate(self, remote):
        with self.lock:
            self.dirs.pop(posixpath.dirname(remote), None)
            self.dirs.pop(remote, None)

    def list(self, remote, fresh=False):
        with self.lock:
            c = self.dirs.get(remote)
            if c and not fresh and time.time() - c[0] < self.ttl:
                return c[1]
        entries = self.adb.listdir(remote)
        if entries is not None:
            with self.lock:
                self.dirs[remote] = (time.time(), entries)
        return entries

    def attr(self, remote):
        if remote == self.root:
            return (S.S_IFDIR | 0o755, 4096, int(time.time()))
        with self.lock:
            w = self.writes.get(remote)
        if w:
            st = os.stat(w[0])
            return (S.S_IFREG | 0o644, st.st_size, int(st.st_mtime))
        parent, name = posixpath.split(remote)
        entries = self.list(parent)
        if entries is not None and name in entries:
            return entries[name]
        if entries is not None:          # parent listed and name not there
            return None
        return self.adb.stat(remote)

    # -- reads
    def cache_file(self, remote, a):
        key = f"{a[1]}-{a[2]}"
        h = hashlib.sha1(remote.encode()).hexdigest()
        local = os.path.join(self.cache_dir, h)
        with self.lock:
            cur = self.chunks.get(remote)
            if not cur or cur[0] != key:
                open(local, 'wb').close()
                self.chunks[remote] = (key, set())
        return local

    def read(self, remote, size, offset):
        with self.lock:
            w = self.writes.get(remote)
        if w:
            with open(w[0], 'rb') as f:
                f.seek(offset); return f.read(size)
        a = self.attr(remote)
        if a is None:
            raise OSError(errno.ENOENT, '')
        fsize = a[1]
        if offset >= fsize:
            return b''
        size = min(size, fsize - offset)
        local = self.cache_file(remote, a)
        first, last = offset // CHUNK, (offset + size - 1) // CHUNK
        with self.lock:
            have = self.chunks[remote][1]
            missing = [c for c in range(first, last + 1) if c not in have]
        if missing:
            start = missing[0]
            # read ahead: fetch up to 8 MiB past the requested range on sequential access
            count = max(missing[-1] - start + 1, min(8, (fsize - 1) // CHUNK - start + 1))
            data = self.adb.read_range(remote, start, count)
            with open(local, 'r+b') as f:
                f.seek(start * CHUNK); f.write(data)
            got = (len(data) + CHUNK - 1) // CHUNK
            with self.lock:
                self.chunks[remote][1].update(range(start, start + got))
        with open(local, 'rb') as f:
            f.seek(offset); return f.read(size)

    # -- writes (staged locally, pushed on release)
    def open_write(self, remote, truncate=False, create=False):
        with self.lock:
            w = self.writes.get(remote)
            if w:
                w[1] += 1
                if truncate:
                    open(w[0], 'wb').close(); w[2] = True
                return
        fd, tmp = tempfile.mkstemp(dir=self.cache_dir, prefix='w-'); os.close(fd)
        dirty = create or truncate
        if not create and not truncate:
            a = self.attr(remote)
            if a and a[1] > 0:
                rc, _, _ = self.adb.run(['pull', remote, tmp], timeout=3600)
                if rc != 0:
                    os.unlink(tmp); raise OSError(errno.EIO, '')
        with self.lock:
            self.writes[remote] = [tmp, 1, dirty]

    def write(self, remote, data, offset):
        with self.lock:
            w = self.writes[remote]; w[2] = True
        with open(w[0], 'r+b') as f:
            f.seek(offset); f.write(data)
        return len(data)

    def truncate(self, remote, length):
        with self.lock:
            w = self.writes.get(remote)
        if w:
            os.truncate(w[0], length); w[2] = True; return
        if length == 0:
            if not self.adb.ok(f": > {shlex.quote(remote)}"):
                raise OSError(errno.EIO, '')
            self.invalidate(remote); return
        self.open_write(remote); self.truncate(remote, length); self.release(remote)

    def flush(self, remote):
        with self.lock:
            w = self.writes.get(remote)
            if not w or not w[2]:
                return
            w[2] = False
        rc, _, err = self.adb.run(['push', w[0], remote], timeout=3600)
        self.invalidate(remote)
        if rc != 0:
            raise OSError(errno.EIO, '')

    def release(self, remote):
        with self.lock:
            w = self.writes.get(remote)
            if not w:
                return
        self.flush(remote)
        with self.lock:
            w[1] -= 1
            if w[1] <= 0:
                self.writes.pop(remote, None)
                try: os.unlink(w[0])
                except OSError: pass

    def simple(self, cmd, *paths):
        if not self.adb.ok(cmd):
            raise OSError(errno.EACCES, '')
        for p in paths:
            self.invalidate(p)

# ----------------------------------------------------------------------------- libfuse3 binding
class Stat(ctypes.Structure):                       # struct stat, x86_64 / aarch64-compatible enough
    _fields_ = [('st_dev', ctypes.c_uint64), ('st_ino', ctypes.c_uint64), ('st_nlink', ctypes.c_uint64),
                ('st_mode', ctypes.c_uint32), ('st_uid', ctypes.c_uint32), ('st_gid', ctypes.c_uint32),
                ('__pad0', ctypes.c_int32), ('st_rdev', ctypes.c_uint64), ('st_size', ctypes.c_int64),
                ('st_blksize', ctypes.c_int64), ('st_blocks', ctypes.c_int64),
                ('st_atime', ctypes.c_int64), ('st_atime_ns', ctypes.c_int64),
                ('st_mtime', ctypes.c_int64), ('st_mtime_ns', ctypes.c_int64),
                ('st_ctime', ctypes.c_int64), ('st_ctime_ns', ctypes.c_int64), ('__res', ctypes.c_int64 * 3)]

class StatVFS(ctypes.Structure):
    _fields_ = [('f_bsize', ctypes.c_ulong), ('f_frsize', ctypes.c_ulong), ('f_blocks', ctypes.c_uint64),
                ('f_bfree', ctypes.c_uint64), ('f_bavail', ctypes.c_uint64), ('f_files', ctypes.c_uint64),
                ('f_ffree', ctypes.c_uint64), ('f_favail', ctypes.c_uint64), ('f_fsid', ctypes.c_ulong),
                ('f_flag', ctypes.c_ulong), ('f_namemax', ctypes.c_ulong), ('__spare', ctypes.c_int * 6)]

P, CP, VP, SZ, OFF = ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int64
FILLER = ctypes.CFUNCTYPE(ctypes.c_int, VP, CP, ctypes.POINTER(Stat), OFF, ctypes.c_int)
F = lambda *a: ctypes.CFUNCTYPE(ctypes.c_int, *a)
OPS = [  # (name, prototype) in libfuse 3 struct fuse_operations order
    ('getattr', F(CP, ctypes.POINTER(Stat), VP)), ('readlink', F(CP, P, SZ)), ('mknod', F(CP, ctypes.c_uint, ctypes.c_uint64)),
    ('mkdir', F(CP, ctypes.c_uint)), ('unlink', F(CP)), ('rmdir', F(CP)), ('symlink', F(CP, CP)),
    ('rename', F(CP, CP, ctypes.c_uint)), ('link', F(CP, CP)), ('chmod', F(CP, ctypes.c_uint, VP)),
    ('chown', F(CP, ctypes.c_uint, ctypes.c_uint, VP)), ('truncate', F(CP, OFF, VP)), ('open', F(CP, VP)),
    ('read', F(CP, P, SZ, OFF, VP)), ('write', F(CP, P, SZ, OFF, VP)), ('statfs', F(CP, ctypes.POINTER(StatVFS))),
    ('flush', F(CP, VP)), ('release', F(CP, VP)), ('fsync', F(CP, ctypes.c_int, VP)),
    ('setxattr', F(CP, CP, P, SZ, ctypes.c_int)), ('getxattr', F(CP, CP, P, SZ)), ('listxattr', F(CP, P, SZ)),
    ('removexattr', F(CP, CP)), ('opendir', F(CP, VP)), ('readdir', F(CP, VP, FILLER, OFF, VP, ctypes.c_int)),
    ('releasedir', F(CP, VP)), ('fsyncdir', F(CP, ctypes.c_int, VP)),
    ('init', ctypes.CFUNCTYPE(VP, VP, VP)), ('destroy', ctypes.CFUNCTYPE(None, VP)), ('access', F(CP, ctypes.c_int)),
    ('create', F(CP, ctypes.c_uint, VP)), ('lock', F(CP, VP, ctypes.c_int, VP)),
    ('utimens', F(CP, VP, VP)), ('bmap', F(CP, SZ, VP)), ('ioctl', F(CP, ctypes.c_uint, VP, VP, ctypes.c_uint, VP)),
    ('poll', F(CP, VP, VP, VP)), ('write_buf', F(CP, VP, OFF, VP)), ('read_buf', F(CP, VP, SZ, OFF, VP)),
    ('flock', F(CP, VP, ctypes.c_int)), ('fallocate', F(CP, ctypes.c_int, OFF, OFF, VP)),
    ('copy_file_range', ctypes.CFUNCTYPE(ctypes.c_ssize_t, CP, VP, OFF, CP, VP, OFF, SZ, ctypes.c_int)),
    ('lseek', ctypes.CFUNCTYPE(OFF, CP, OFF, ctypes.c_int, VP)),
]

class Operations(ctypes.Structure):
    _fields_ = [(n, t) for n, t in OPS]

def fileinfo_flags(fi):            # struct fuse_file_info starts with "int flags" in every libfuse 3 release
    return ctypes.cast(fi, ctypes.POINTER(ctypes.c_int))[0] if fi else 0

def build_ops(fs: PhoneFS):
    uid, gid = os.getuid(), os.getgid()

    def guard(fn):
        def wrapper(*args):
            try:
                r = fn(*args)
                return 0 if r is None else r
            except OSError as e:
                return -(e.errno or errno.EIO)
            except Exception as e:  # never let an exception cross into C
                sys.stderr.write(f"vivo-phonefs: {fn.__name__}: {e!r}\n")
                return -errno.EIO
        wrapper.__name__ = fn.__name__
        return wrapper

    def fill(st, a):
        mode, size, mtime = a
        ctypes.memset(ctypes.byref(st), 0, ctypes.sizeof(st))
        st.st_mode = (S.S_IFDIR | 0o755) if S.S_ISDIR(mode) else (S.S_IFREG | 0o644)
        st.st_nlink = 2 if S.S_ISDIR(mode) else 1
        st.st_size, st.st_uid, st.st_gid = size, uid, gid
        st.st_blksize, st.st_blocks = 4096, (size + 511) // 512
        st.st_atime = st.st_mtime = st.st_ctime = mtime

    d = lambda b: b.decode('utf-8', 'surrogateescape')

    @guard
    def getattr(path, st, fi):
        a = fs.attr(fs.rp(d(path)))
        if a is None:
            raise OSError(errno.ENOENT, '')
        fill(st.contents, a)

    @guard
    def readdir(path, buf, filler, off, fi, flags):
        entries = fs.list(fs.rp(d(path)), fresh=True)
        if entries is None:
            raise OSError(errno.ENOENT, '')
        st = Stat()
        filler(buf, b'.', None, 0, 0); filler(buf, b'..', None, 0, 0)
        for name, a in entries.items():
            fill(st, a)
            if filler(buf, name.encode('utf-8', 'surrogateescape'), ctypes.byref(st), 0, 0):
                break

    @guard
    def open_(path, fi):
        flags = fileinfo_flags(fi)
        if flags & os.O_ACCMODE != os.O_RDONLY:
            fs.open_write(fs.rp(d(path)), truncate=bool(flags & os.O_TRUNC))

    @guard
    def create(path, mode, fi):
        r = fs.rp(d(path)); fs.open_write(r, create=True); fs.flush_needed = True
        with fs.lock:
            fs.writes[r][2] = True
        fs.flush(r); fs.invalidate(r)

    @guard
    def read(path, buf, size, off, fi):
        data = fs.read(fs.rp(d(path)), size, off)
        ctypes.memmove(buf, data, len(data))
        return len(data)

    @guard
    def write(path, buf, size, off, fi):
        return fs.write(fs.rp(d(path)), ctypes.string_at(buf, size), off)

    @guard
    def truncate(path, length, fi):
        fs.truncate(fs.rp(d(path)), length)

    @guard
    def flush(path, fi):
        fs.flush(fs.rp(d(path)))

    @guard
    def release(path, fi):
        fs.release(fs.rp(d(path)))

    @guard
    def fsync(path, datasync, fi):
        fs.flush(fs.rp(d(path)))

    @guard
    def mkdir(path, mode):
        r = fs.rp(d(path)); fs.simple(f"mkdir -p {shlex.quote(r)}", r)

    @guard
    def unlink(path):
        r = fs.rp(d(path)); fs.simple(f"rm -f {shlex.quote(r)}", r)

    @guard
    def rmdir(path):
        r = fs.rp(d(path)); fs.simple(f"rmdir {shlex.quote(r)}", r)

    @guard
    def rename(src, dst, flags):
        a, b = fs.rp(d(src)), fs.rp(d(dst))
        fs.simple(f"mv -f {shlex.quote(a)} {shlex.quote(b)}", a, b)

    @guard
    def statfs(path, sv):
        rc, out, _ = fs.adb.shell(f"df -k {shlex.quote(fs.root)} 2>/dev/null | tail -n 1")
        p = out.split()
        v = sv.contents
        v.f_bsize = v.f_frsize = 1024; v.f_namemax = 255
        try:
            v.f_blocks, v.f_bfree = int(p[1]), int(p[3]); v.f_bavail = v.f_bfree
        except (IndexError, ValueError):
            pass

    @guard
    def access(path, mode):
        if fs.attr(fs.rp(d(path))) is None:
            raise OSError(errno.ENOENT, '')

    noop = guard(lambda *a: 0)
    impl = dict(getattr=getattr, readdir=readdir, open=open_, create=create, read=read, write=write,
                truncate=truncate, flush=flush, release=release, fsync=fsync, mkdir=mkdir, unlink=unlink,
                rmdir=rmdir, rename=rename, statfs=statfs, access=access,
                chmod=noop, chown=noop, utimens=noop, opendir=noop, releasedir=noop)
    ops = Operations()
    keep = []
    for name, proto in OPS:
        if name in impl:
            cb = proto(impl[name]); keep.append(cb); setattr(ops, name, cb)
    return ops, keep

def fuse_main(argv, ops):
    lib = ctypes.CDLL(ctypes.util.find_library('fuse3') or 'libfuse3.so.3')
    args = (ctypes.c_char_p * len(argv))(*[a.encode() for a in argv])
    if hasattr(lib, 'fuse_main_real_versioned'):           # libfuse >= 3.17
        class Ver(ctypes.Structure):
            _fields_ = [('major', ctypes.c_uint32), ('minor', ctypes.c_uint32), ('hotfix', ctypes.c_uint32), ('padding', ctypes.c_uint32)]
        v = Ver(3, 17, 0, 0)
        return lib.fuse_main_real_versioned(len(argv), args, ctypes.byref(ops), ctypes.sizeof(ops), ctypes.byref(v), None)
    return lib.fuse_main_real(len(argv), args, ctypes.byref(ops), ctypes.sizeof(ops), None)

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('mountpoint')
    ap.add_argument('--serial')
    ap.add_argument('--root', default='/sdcard', help='phone folder to expose (default: internal storage)')
    ap.add_argument('--name', default='vivo phone')
    ap.add_argument('-f', '--foreground', action='store_true')
    a = ap.parse_args()
    adb = Adb(a.serial)
    rc, out, err = adb.shell('echo ok')
    if 'ok' not in out:
        sys.exit(f"vivo-phonefs: phone not reachable over adb: {err.strip() or out.strip()}")
    os.makedirs(a.mountpoint, exist_ok=True)
    cache = tempfile.mkdtemp(prefix='vivo-phonefs-')
    fs = PhoneFS(adb, a.root, cache)
    ops, keep = build_ops(fs)
    argv = ['vivo-phonefs', a.mountpoint, '-s', '-o',
            f'fsname=vivo-phone,subtype=vivophone,attr_timeout=3,entry_timeout=3,negative_timeout=1']
    if a.foreground:
        argv.append('-f')
    try:
        sys.exit(fuse_main(argv, ops))
    finally:
        import shutil; shutil.rmtree(cache, ignore_errors=True)

if __name__ == '__main__':
    main()
