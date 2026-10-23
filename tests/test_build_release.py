"""Release boundary tests use temporary projects; no installed skill is touched."""

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from build_release import build_release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "toolkit"
        self.root.mkdir()
        self.package = {"name": "example-toolkit", "version": "0.2.0", "files": ["README.md", "SKILL.md", "CHANGELOG.md", "scripts", "tests"]}
        self.write_package()
        for filename in ("README.md", "SKILL.md", "CHANGELOG.md", "scripts/tool.py", "tests/test_tool.py"):
            self.write(filename, f"fixture: {filename}\n")

    def write(self, relative, contents):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
        return path

    def write_package(self):
        self.write("package.json", json.dumps(self.package))

    def test_default_package_has_manifest_docs_sources_and_tests(self):
        output = build_release(self.root)
        self.assertEqual(output, self.root / "releases/example-toolkit-v0.2.0.zip")
        with zipfile.ZipFile(output) as archive:
            expected = {"package.json", "README.md", "SKILL.md", "CHANGELOG.md", "scripts/tool.py", "tests/test_tool.py"}
            self.assertEqual(set(archive.namelist()), {f"example-toolkit/{name}" for name in expected})
            for name in expected:
                self.assertEqual(archive.read(f"example-toolkit/{name}"), (self.root / name).read_bytes())

    def test_excludes_evidence_archives_dependencies_and_cache_at_every_depth(self):
        forbidden = ["validation/evidence.json", "releases/old.zip", "node_modules/dependency.js", ".git/config", "__pycache__/tool.pyc", ".DS_Store", "stale.pyc", "previous.zip"]
        for filename in forbidden:
            self.write(filename, "private fixture")
            self.write(f"scripts/nested/{filename}", "private fixture")
        output = build_release(self.root)
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(len(archive.namelist()), 6)
            self.assertFalse(any(b"private fixture" in archive.read(name) for name in archive.namelist()))

    def test_custom_output_inside_sources_cannot_include_itself_or_previous_archive(self):
        first = build_release(self.root, "scripts/first.zip")
        second = build_release(self.root, "scripts/second.zip")
        self.assertTrue(first.is_file())
        with zipfile.ZipFile(second) as archive:
            self.assertFalse(any(name.endswith(".zip") for name in archive.namelist()))
            self.assertEqual(len(archive.namelist()), 6)

    def test_absolute_output_outside_root_is_supported(self):
        output = self.root.parent / "export.zip"
        self.assertEqual(build_release(self.root, output), output)
        self.assertTrue(output.is_file())

    def test_existing_output_is_never_overwritten(self):
        output = build_release(self.root)
        original = output.read_bytes()
        with self.assertRaisesRegex(FileExistsError, "overwrite"):
            build_release(self.root)
        self.assertEqual(output.read_bytes(), original)

    def test_invalid_allowlists_do_not_create_archive(self):
        invalid = [None, [], "scripts", [None], [""], ["."], ["../outside"], ["/absolute"], ["scripts/../README.md"], ["scripts//tool.py"], ["scripts\\tool.py"], ["scripts/*"], ["scripts", "scripts"], ["missing"], ["empty"], ["validation"], ["ignored-only"]]
        (self.root / "empty").mkdir()
        self.write("validation/evidence.json", "{}")
        self.write("ignored-only/stale.pyc", "bytecode")
        for entries in invalid:
            with self.subTest(entries=entries):
                self.package["files"] = entries
                self.write_package()
                with self.assertRaises(ValueError):
                    build_release(self.root)
                self.assertFalse((self.root / "releases").exists())

    def test_unsafe_name_and_version_are_rejected(self):
        for field in ("name", "version"):
            original = self.package[field]
            for value in (None, "", "../outside", "/outside", "a/b", ".", "..", "bad\nname"):
                with self.subTest(field=field, value=value):
                    self.package[field] = value
                    self.write_package()
                    with self.assertRaises(ValueError):
                        build_release(self.root)
            self.package[field] = original

    def test_symlinked_files_and_directories_are_rejected(self):
        outside = self.root.parent / "outside.txt"
        outside.write_text("must not be packaged")
        for target in (outside, self.root / "README.md", self.root / "tests"):
            with self.subTest(target=str(target)):
                link = self.root / "scripts/link"
                link.symlink_to(target, target_is_directory=target.is_dir())
                try:
                    with self.assertRaisesRegex(ValueError, "Symbolic links"):
                        build_release(self.root)
                finally:
                    link.unlink()
        link = self.root / "linked-tests"
        link.symlink_to(self.root / "tests", target_is_directory=True)
        self.package["files"] = ["linked-tests/test_tool.py"]
        self.write_package()
        with self.assertRaisesRegex(ValueError, "Symbolic links"):
            build_release(self.root)

    def test_manifest_and_output_symlinks_are_rejected(self):
        manifest = self.root / "package.json"
        saved = self.root / "saved-manifest.json"
        manifest.rename(saved)
        manifest.symlink_to(saved)
        with self.assertRaisesRegex(ValueError, "Symbolic links"):
            build_release(self.root)
        manifest.unlink()
        saved.rename(manifest)
        outside = self.root.parent / "exports"
        outside.mkdir()
        (self.root / "exports").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symbolic links"):
            build_release(self.root, "exports/release.zip")
        self.assertFalse((outside / "release.zip").exists())
        (self.root / "dangling.zip").symlink_to(outside / "missing.zip")
        with self.assertRaisesRegex(ValueError, "Symbolic links"):
            build_release(self.root, "dangling.zip")

    def test_relative_output_escape_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "inside"):
            build_release(self.root, "../escape.zip")
        self.assertFalse((self.root.parent / "escape.zip").exists())

    def test_cli_locates_root_from_script_and_refuses_second_build(self):
        source = Path(__file__).resolve().parent.parent / "scripts/build_release.py"
        script = self.root / "scripts/build_release.py"
        script.write_bytes(source.read_bytes())
        command = [sys.executable, "-B", str(script), "--out", "exports/cli.zip"]
        first = subprocess.run(command, cwd=self.root.parent, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        output = self.root / "exports/cli.zip"
        self.assertEqual(first.stdout.strip(), str(output))
        original = output.read_bytes()
        second = subprocess.run(command, cwd=self.root.parent, capture_output=True, text=True)
        self.assertEqual(second.returncode, 2)
        self.assertIn("overwrite", second.stderr)
        self.assertEqual(output.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
