import base64
import os
from pathlib import Path
import platform
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

SUPPORTED = sys.platform == 'linux' and platform.machine() == 'x86_64' and __import__('shutil').which('gcc')

class BackendTests(unittest.TestCase):
    def test_argv_validation(self):
        self.assertEqual(server.validate_args(['A','B']), ['A','B'])
        with self.assertRaises(ValueError): server.validate_args(['foo\x00bar'])
        with self.assertRaises(ValueError): server.validate_args(['Z' * 2049])

    def test_elf_signature(self):
        with self.assertRaises(ValueError): server.validate_elf(b'not-an-elf')

    @unittest.skipUnless(SUPPORTED, 'Linux x86-64 + gcc needed')
    def test_native_demo_allocations_and_reuse(self):
        result = server.run_demo({'args': ['HELLO']})
        self.assertEqual(result['exit_code'], 0, result['stderr'])
        allocations = [e['ptr'] for e in result['events'] if e['op'] == 'malloc' and int(e['size']) < 100]
        self.assertTrue(allocations)
        self.assertEqual(allocations[0], allocations[2], 'freed address should be reused in this glibc demo')
        self.assertTrue(any(e['op']=='free-before' for e in result['events']))

    @unittest.skipUnless(SUPPORTED, 'Linux x86-64 + gcc needed')
    def test_asan_detects_heap_overflow(self):
        src = (Path(__file__).resolve().parents[1]/'examples'/'vulnerable_demo.c').read_text()
        result = server.compile_and_run(src, ['A'*32], asan=True)
        self.assertIn('heap-buffer-overflow', result['stderr'])
        self.assertNotEqual(result['exit_code'], 0)

if __name__ == '__main__': unittest.main()
