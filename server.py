#!/usr/bin/env python3
"""HeapLab local HTTP server. Runs only on 127.0.0.1; native execution is NOT sandboxed."""
import base64
import binascii
import ctypes
import http.server
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
MAX_BODY = 12 * 1024 * 1024
MAX_EXECUTABLE = 8 * 1024 * 1024
MAX_TRACE = 7 * 1024 * 1024
TIMEOUT = 6
PR_SET_NO_NEW_PRIVS = 38


def secure_limits(asan=False):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT + 1, TIMEOUT + 2))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_TRACE, MAX_TRACE))
    resource.setrlimit(resource.RLIMIT_NOFILE, (96, 96))
    if not asan:
        resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024,) * 2)
    try:
        ctypes.CDLL(None).prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    except (AttributeError, OSError):
        pass


def execute(path, args, preload=None, asan=False, stdin_text=""):
    # No shell=True, stdin is DEVNULL, outputs and trace use quota-limited regular files.
    args = validate_args(args)
    if not isinstance(stdin_text, str) or len(stdin_text.encode("utf-8")) > 16384 or "\x00" in stdin_text:
        raise ValueError("Entrée standard invalide (max 16 Kio, sans NUL).")
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr, tempfile.TemporaryFile() as trace:
        env = dict(os.environ)
        env.pop('LD_PRELOAD', None)
        env.pop('LD_LIBRARY_PATH', None)
        env.pop('HEAPLAB_TRACE_FD', None)
        env.pop('HEAPLAB_SECRET', None)
        if preload:
            env['LD_PRELOAD'] = str(preload)
            env['HEAPLAB_TRACE_FD'] = str(trace.fileno())
        if asan:
            env['ASAN_OPTIONS'] = 'detect_leaks=0:halt_on_error=1:abort_on_error=0'
            env['UBSAN_OPTIONS'] = 'halt_on_error=1:print_stacktrace=1'
        try:
            p = subprocess.Popen([str(path), *args], cwd=str(path.parent), stdin=subprocess.PIPE,
                                 stdout=stdout, stderr=stderr, env=env, start_new_session=True,
                                 preexec_fn=lambda: secure_limits(asan), pass_fds=(trace.fileno(),) if preload else ())
        except OSError as exc:
            raise ValueError(f'Exécution impossible : {exc}') from exc
        timed_out = False
        try:
            p.communicate(input=stdin_text.encode("utf-8"), timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            p.wait()
        trace.seek(0)
        records = []
        invalid = 0
        for line in trace.read(MAX_TRACE).splitlines()[:700]:
            try:
                records.append(json.loads(line))
            except (ValueError, UnicodeDecodeError):
                invalid += 1
        stdout.seek(0)
        stderr.seek(0)
        return {'events': records, 'exit_code': p.returncode, 'timed_out': timed_out,
                'stdout': stdout.read(12000).decode('utf-8', 'replace'),
                'stderr': stderr.read(24000).decode('utf-8', 'replace'),
                'invalid_events': invalid,
                'warning': 'Trace native : allocations interceptées seulement. Ce processus n’est pas isolé du système.'}


def validate_args(args):
    if not isinstance(args, list) or len(args) > 20:
        raise ValueError('Maximum 20 arguments argv ; fournir un tableau de chaînes.')
    if not all(isinstance(x, str) and len(x.encode('utf-8')) <= 2048 and '\0' not in x for x in args):
        raise ValueError('Argument invalide : 2048 octets maximum par argument, sans NUL.')
    return args


def trace_library():
    lib = ROOT / 'libheaplab.so'
    source = ROOT / 'tracer.c'
    if not shutil.which('gcc'):
        raise ValueError('gcc est nécessaire au traceur natif Linux.')
    if not lib.exists() or lib.stat().st_mtime < source.stat().st_mtime:
        run = subprocess.run(['gcc', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra',
                              '-o', str(lib), str(source), '-ldl'],
                             capture_output=True, text=True, timeout=15)
        if run.returncode:
            raise ValueError('Compilation du traceur impossible : ' + run.stderr[-2000:])
    return lib


def validate_elf(blob):
    if len(blob) > MAX_EXECUTABLE:
        raise ValueError('ELF trop volumineux (8 Mio maximum).')
    if len(blob) < 20 or blob[:4] != b'\x7fELF':
        raise ValueError('Fichier non reconnu comme ELF.')
    if blob[4] != 2 or blob[5] != 1 or blob[18:20] != b'\x3e\x00':
        raise ValueError('Seuls les ELF x86-64 little-endian sont pris en charge.')
    # Dynamic binaries only; static binaries do not load LD_PRELOAD.
    return True


def run_elf(data):
    try:
        blob = base64.b64decode(data['content'], validate=True)
    except (KeyError, binascii.Error) as exc:
        raise ValueError('Fichier binaire absent ou base64 invalide.') from exc
    validate_elf(blob)
    args = validate_args(data.get('args', []))
    with tempfile.TemporaryDirectory(prefix='heaplab-native-') as folder:
        exe = Path(folder) / 'target'
        exe.write_bytes(blob)
        exe.chmod(0o700)
        return execute(exe, args, preload=trace_library())


def run_demo(data):
    src = ROOT / 'examples' / 'heap_demo.c'
    return compile_and_run(src.read_text(encoding='utf-8'), validate_args(data.get('args', ['HELLO'])), False)


def compile_and_run(source, args, asan, language="c", stdin_text=""):
    if len(source.encode('utf-8')) > 150000:
        raise ValueError('Source C/C++ trop volumineuse (150 Ko maximum).')
    if language not in ('c', 'cpp'):
        raise ValueError('Langage non reconnu : c ou cpp uniquement.')
    compiler = shutil.which('g++' if language == 'cpp' else 'gcc')
    if not compiler:
        raise ValueError('Compilateur requis : gcc (C) ou g++ (C++).')
    with tempfile.TemporaryDirectory(prefix='heaplab-build-') as folder:
        src = Path(folder) / ('target.cpp' if language == 'cpp' else 'target.c')
        exe = Path(folder) / 'target'
        src.write_text(source, encoding='utf-8')
        flags = ['-g', '-O0', '-fno-builtin', '-Wall', '-Wextra']
        if language == 'cpp': flags += ['-std=c++17']
        if asan:
            flags += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-no-pie']
        build = subprocess.run([compiler, *flags, str(src), '-o', str(exe)], capture_output=True,
                               text=True, timeout=15)
        if build.returncode:
            return {'events': [], 'exit_code': None, 'build_error': build.stderr[-18000:],
                    'stdout': '', 'stderr': '', 'timed_out': False}
        result = execute(exe, args, preload=None if asan else trace_library(), asan=asan, stdin_text=stdin_text)
        result['compiler_warnings'] = build.stderr[-4000:]
        result['sanitizer'] = asan
        return result


class App(http.server.BaseHTTPRequestHandler):
    server_version = 'HeapLab'
    def respond(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def local_request(self):
        host = self.headers.get('Host', '')
        return host in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

    def do_GET(self):
        if not self.local_request():
            return self.respond({'error': 'Hôte non local rejeté'}, 403)
        if self.path == '/api/health':
            return self.respond({'ready': sys.platform.startswith('linux'),
                                 'gpp': bool(shutil.which('g++')), 'arch': platform.machine(),
                                 'libc': ' '.join(platform.libc_ver()), 'gcc': bool(shutil.which('gcc'))})
        if self.path == '/':
            resource_path = ROOT / 'index.html'
            ctype = 'text/html; charset=utf-8'
        elif self.path in ('/app.js', '/engine.js', '/chunk_inspector.js', '/source_sim.js', '/source_integration.js'):
            resource_path = ROOT / self.path.lstrip('/')
            ctype = 'application/javascript; charset=utf-8'
        else:
            self.send_error(404)
            return
        body = resource_path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        origin = self.headers.get('Origin')
        authorized_origins = (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}')
        if not self.local_request() or (origin is not None and origin not in authorized_origins):
            return self.respond({'error': 'Origine non locale rejetée'}, 403)
        if self.headers.get('X-HeapLab-Run') != 'local-execution' or not self.headers.get('Content-Type', '').startswith('application/json'):
            return self.respond({'error': 'Requête non autorisée (entête local requis)'}, 403)
        if self.path not in ('/api/run-elf', '/api/run-source', '/api/run-asan', '/api/run-demo'):
            return self.respond({'error': 'Route inconnue'}, 404)
        length = int(self.headers.get('Content-Length', '-1'))
        if length < 0 or length > MAX_BODY:
            return self.respond({'error': 'Requête trop grande / invalide'}, 413)
        try:
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or data.get('consent') is not True:
                raise ValueError('Confirme explicitement l’exécution locale du programme.')
            if not sys.platform.startswith('linux') or platform.machine() not in ('x86_64', 'AMD64'):
                raise ValueError('Moteur réel disponible sur Linux x86-64 seulement.')
            if self.path == '/api/run-elf': result = run_elf(data)
            elif self.path == '/api/run-demo': result = run_demo(data)
            elif self.path == '/api/run-asan': result = compile_and_run(data.get('source', ''), validate_args(data.get('args', [])), True, data.get('language', 'c'), data.get('stdin', ''))
            else: result = compile_and_run(data.get('source', ''), validate_args(data.get('args', [])), False, data.get('language', 'c'), data.get('stdin', ''))
            return self.respond(result)
        except (ValueError, TypeError, UnicodeError, subprocess.TimeoutExpired) as exc:
            return self.respond({'error': str(exc)}, 400)
        except Exception as exc:
            return self.respond({'error': 'Erreur du moteur : ' + str(exc)}, 500)

    def log_message(self, fmt, *args):
        print('[HeapLab]', fmt % args)


def main():
    if sys.platform != 'linux':
        print('Le serveur natif nécessite Linux. Ouvre index.html seul pour le simulateur.')
        sys.exit(1)
    import argparse
    p = argparse.ArgumentParser(description='HeapLab - simulateur et traceur glibc local')
    p.add_argument('--port', type=int, default=8765)
    args = p.parse_args()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), App)
    print(f'HeapLab : http://127.0.0.1:{args.port} (uniquement loopback)')
    print('ATTENTION : ce serveur exécute les ELF/source C/C++ soumis. Utiliser une VM isolée pour les programmes non fiables.')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()

if __name__ == '__main__':
    main()
