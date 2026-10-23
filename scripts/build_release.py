"""Build a source-only release ZIP from package.json's explicit files list.

Relative output paths are resolved from the toolkit root, not the shell's cwd.
The package manifest is always included; all other inputs must be allowlisted.
"""

import argparse
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath


EXCLUDED_NAMES = {
    "validation", "releases", "node_modules", ".git", "__pycache__", ".DS_Store",
}


def _excluded(relative):
    return any(part in EXCLUDED_NAMES for part in relative.parts) or relative.suffix.lower() in {".pyc", ".zip"}


def _relative_entry(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError("Each files entry must be a nonempty relative file or directory path.")
    if any(ord(character) < 32 for character in value) or any(character in value for character in "*?[]"):
        raise ValueError(f"Globs and control characters are not allowed in files: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError(f"Unsafe files entry: {value!r}")
    return path


def _source_kind(root, path):
    """Validate every path component before following it into the source tree."""
    relative = path.relative_to(root)
    current = root
    for component in relative.parts:
        current = current / component
        if current.is_symlink():
            raise ValueError(f"Symbolic links are not allowed: {current.relative_to(root)}")
    try:
        path.resolve(strict=True).relative_to(root)
    except (OSError, ValueError) as error:
        raise ValueError(f"Missing or escaping source path: {relative}") from error
    mode = path.stat().st_mode
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    raise ValueError(f"Only regular files and directories are allowed: {relative}")


def _collect(root, path):
    kind = _source_kind(root, path)
    if _excluded(path.relative_to(root)):
        return []
    if kind == "file":
        return [path]
    files = []
    for child in sorted(path.iterdir()):
        files.extend(_collect(root, child))
    return files


def _output_path(root, output):
    output = Path(output)
    if not output.is_absolute():
        if ".." in output.parts:
            raise ValueError("Relative output paths must stay inside the toolkit root.")
        output = root / output
    # Check the requested route before resolve() could hide a redirected directory.
    for component in (output, *output.parents):
        if component.is_symlink():
            raise ValueError(f"Symbolic links are not allowed in the output path: {component}")
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite an existing output: {output}")
    if output.suffix.lower() != ".zip":
        raise ValueError("Release output must have a .zip extension.")
    return output


def build_release(root, output=None):
    """Return the new ZIP path; reject invalid inputs and existing outputs."""
    root = Path(root)
    if root.is_symlink():
        raise ValueError("The toolkit root must not be a symbolic link.")
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("The toolkit root must be a directory.")
    manifest_path = root / "package.json"
    if _source_kind(root, manifest_path) != "file":
        raise ValueError("package.json must be a regular file.")
    package = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(package, dict):
        raise ValueError("package.json must contain an object.")
    for field in ("name", "version"):
        value = package.get(field)
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", value):
            raise ValueError(f"package.json {field} must be a safe single path component.")
    entries = package.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("package.json files must be a nonempty explicit allowlist.")
    selected = {manifest_path}
    seen = set()
    for value in entries:
        relative = _relative_entry(value)
        if relative in seen:
            raise ValueError(f"Duplicate files entry: {value}")
        seen.add(relative)
        files = _collect(root, root.joinpath(*relative.parts))
        if not files:
            raise ValueError(f"Allowlisted entry has no eligible files: {value}")
        selected.update(files)
    output = _output_path(root, output if output is not None else f"releases/{package['name']}-v{package['version']}.zip")
    # Snapshot inputs before creating output, including when --out is inside an
    # allowlisted directory. Previous ZIPs are excluded by _excluded as well.
    contents = []
    for source in sorted(selected):
        if _source_kind(root, source) != "file":
            raise ValueError(f"Source changed during collection: {source}")
        archive_name = f"{package['name']}/{source.relative_to(root).as_posix()}"
        info = zipfile.ZipInfo.from_file(source, arcname=archive_name)
        info.compress_type = zipfile.ZIP_DEFLATED
        contents.append((info, source.read_bytes()))
    output.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            created = True
            for info, content in contents:
                archive.writestr(info, content)
    except Exception:
        if created:
            output.unlink(missing_ok=True)
        raise
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="New ZIP path; relative paths start at the toolkit root")
    args = parser.parse_args(argv)
    try:
        output = build_release(Path(__file__).resolve().parent.parent, args.out)
    except (OSError, ValueError) as error:
        print(f"Release build failed: {error}", file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
