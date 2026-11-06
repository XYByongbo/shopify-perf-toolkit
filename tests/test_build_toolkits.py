"""Standalone SEO installation and shared-source release boundary checks."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile
from build_toolkits import stage_seo, build_toolkits
from build_release import build_release


class ToolkitSplitTests(unittest.TestCase):
    def fixture(self, temporary):
        root = Path(temporary).resolve() / 'root'
        package_dir = root / 'packages/seo'
        package_dir.mkdir(parents=True)
        (root / 'package.json').write_text(json.dumps({'name': 'shopify-perf-toolkit', 'version': '0.16.0', 'files': ['packages']}))
        (root / 'package-lock.json').write_text(json.dumps({'version': '0.16.0', 'packages': {'': {'version': '0.16.0'}}}))
        (package_dir / 'package.json').write_text(json.dumps({'name': 'shopify-seo-toolkit', 'version': '0.16.0', 'files': ['package-lock.json']}))
        (package_dir / 'package-lock.json').write_text(json.dumps({'version': '0.16.0', 'packages': {'': {'version': '0.16.0'}}}))
        (package_dir / 'release-map.json').write_text(json.dumps({'package.json': 'packages/seo/package.json', 'package-lock.json': 'packages/seo/package-lock.json'}))
        return root, package_dir

    def test_mapping_rejects_escaping_and_symlink_sources(self):
        for mapping in [{'../escape': 'package.json'}, {'package.json': '../outside'}, {'package.json': 'alias'}, {'package.json': '/absolute'}]:
            with self.subTest(mapping=mapping), tempfile.TemporaryDirectory() as temporary:
                root, package_dir = self.fixture(temporary)
                (root / 'alias').symlink_to(root / 'package.json')
                (package_dir / 'release-map.json').write_text(json.dumps(mapping))
                with self.assertRaises(ValueError):
                    stage_seo(root, Path(temporary).resolve() / 'stage')

    def test_versions_must_agree_before_either_release_is_published(self):
        for target in ['package.json', 'package-lock.json']:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root, package_dir = self.fixture(temporary)
                file = package_dir / target
                data = json.loads(file.read_text())
                data['version'] = '0.15.1'
                file.write_text(json.dumps(data))
                output = Path(temporary).resolve() / 'release'
                with self.assertRaises(ValueError):
                    build_toolkits(root, output)
                self.assertFalse(output.exists())

    def test_performance_lock_mismatch_blocks_both_packages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            (root / 'package-lock.json').write_text('{}')
            output = Path(temporary).resolve() / 'release'
            with self.assertRaisesRegex(ValueError, 'Performance lockfile'):
                build_toolkits(root, output)
            self.assertFalse(output.exists())

    def test_release_output_is_external_and_cannot_overwrite_existing_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            with self.assertRaises(ValueError):
                build_toolkits(root, root / 'release')
            output = Path(temporary).resolve() / 'release'
            archives = build_toolkits(root, output)
            manifest = json.loads((output / 'release-manifest.json').read_text())
            self.assertEqual(len(manifest['packages']), 2)
            before = [p.read_bytes() for p in archives]
            with self.assertRaises(FileExistsError):
                build_toolkits(root, output)
            self.assertEqual(before, [p.read_bytes() for p in archives])

    def test_seo_package_installs_and_runs_without_performance_or_node_modules(self):
        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary).resolve() / 'seo'
            stage.mkdir()
            package = stage_seo(root, stage)
            self.assertFalse(package.get('dependencies'))
            self.assertFalse((stage / 'lib/measure.mjs').exists())
            self.assertFalse((stage / 'scripts/perfkit.mjs').exists())
            for file in (root / 'lib/core').glob('*.mjs'):
                self.assertEqual(file.read_bytes(), (stage / 'lib/core' / file.name).read_bytes())
            archive = build_release(stage, Path(temporary).resolve() / 'seo.zip')
            unpacked = Path(temporary).resolve() / 'unpacked'
            with zipfile.ZipFile(archive) as z:
                self.assertIsNone(z.testzip())
                self.assertFalse(any('node_modules/' in n for n in z.namelist()))
                z.extractall(unpacked)
            installed = unpacked / package['name']
            subprocess.run(['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=installed, capture_output=True, check=True)
            completed = subprocess.run(['node', 'scripts/seokit.mjs', 'doctor'], cwd=installed, capture_output=True, text=True, check=True)
            self.assertFalse(json.loads(completed.stdout)['lighthouseRequired'])
            result = subprocess.run(['npm', 'test'], cwd=installed, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('# fail 0', result.stdout)


if __name__ == '__main__':
    unittest.main()
