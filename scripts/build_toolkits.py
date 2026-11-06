"""Build standalone perfkit and seokit ZIPs from one maintained source tree."""
import argparse
import hashlib
import json
import shutil
import tempfile
from pathlib import Path

from build_release import build_release, _collect, _relative_entry, _source_kind, _output_path


def stage_seo(root, stage):
    root = Path(root).resolve(strict=True)
    mapping_path = root / 'packages/seo/release-map.json'
    _source_kind(root, mapping_path)
    mapping = json.loads(mapping_path.read_text())
    if not isinstance(mapping, dict) or not mapping:
        raise ValueError('SEO release map must be a nonempty destination/source map.')
    destinations = set()
    for target, source in mapping.items():
        target = _relative_entry(target)
        source = root.joinpath(*_relative_entry(source).parts)
        files = _collect(root, source)
        if not files:
            raise ValueError('Empty SEO release source: ' + str(source))
        directory = source.is_dir()
        for file in files:
            relative = target / file.relative_to(source).as_posix() if directory else target
            if str(relative) in destinations:
                raise ValueError('Overlapping SEO release destinations.')
            destinations.add(str(relative))
            destination = Path(stage).joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, destination)
            if str(relative) in {'README.md', 'SKILL.md'}:
                text = destination.read_text(encoding='utf-8')
                text = text.replace('(../../references/', '(references/').replace('(../../assets/', '(assets/').replace('(../../THIRD_PARTY_NOTICES.md)', '(THIRD_PARTY_NOTICES.md)')
                destination.write_text(text, encoding='utf-8')
    package = json.loads((Path(stage) / 'package.json').read_text())
    root_package = json.loads((root / 'package.json').read_text())
    lock = json.loads((Path(stage) / 'package-lock.json').read_text())
    if package['name'] != 'shopify-seo-toolkit' or package['version'] != root_package['version']:
        raise ValueError('SEO/performance release versions differ.')
    if lock['version'] != package['version'] or lock['packages']['']['version'] != package['version']:
        raise ValueError('SEO lockfile version differs.')
    return package


def build_toolkits(root, output):
    root = Path(root).resolve(strict=True)
    output = Path(output)
    if not output.is_absolute():
        raise ValueError('An absolute external output directory is required.')
    if output.resolve() == root or root in output.resolve().parents:
        raise ValueError('Release artifacts must be outside the repository.')
    package = json.loads((root / 'package.json').read_text())
    version = package['version']
    lock_path = root / 'package-lock.json'
    _source_kind(root, lock_path)
    lock = json.loads(lock_path.read_text())
    if lock.get('version') != version or lock.get('packages', {}).get('', {}).get('version') != version:
        raise ValueError('Performance lockfile version differs.')
    paths = [_output_path(root, output / f'{name}-v{version}.zip')
             for name in ('shopify-perf-toolkit', 'shopify-seo-toolkit')]
    for file in [*paths, *(Path(str(p) + '.sha256') for p in paths), output / 'release-manifest.json']:
        if file.exists() or file.is_symlink():
            raise FileExistsError('Refusing to overwrite release artifact: ' + str(file))
    with tempfile.TemporaryDirectory(prefix='toolkit-release-') as temporary:
        temporary = Path(temporary).resolve()
        seo = temporary / 'seo'
        seo.mkdir()
        stage_seo(root, seo)
        built = [build_release(root, temporary / 'perf.zip'), build_release(seo, temporary / 'seo.zip')]
        output.mkdir(parents=True, exist_ok=True)
        records = []
        for source, destination in zip(built, paths):
            data = source.read_bytes()
            with destination.open('xb') as stream:
                stream.write(data)
            digest = hashlib.sha256(data).hexdigest()
            with Path(str(destination) + '.sha256').open('x') as stream:
                stream.write(digest + '  ' + destination.name + '\n')
            records.append({'file': destination.name, 'sha256': digest, 'bytes': len(data)})
        with (output / 'release-manifest.json').open('x') as stream:
            json.dump({'version': version, 'packages': records,
                       'sharedSource': 'lib/core; SEO rules shared by legacy quality audit',
                       'validation': 'build-only; independent installation checks recorded separately'}, stream, indent=2)
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', required=True)
    args = parser.parse_args()
    try:
        for path in build_toolkits(Path(__file__).resolve().parent.parent, args.out_dir):
            print(path)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(2, f'Release failed: {error}\n')


if __name__ == '__main__':
    main()
