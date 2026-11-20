"""Package the reviewed public source and prebuilt marketplace without local data."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
assert re.fullmatch(r'\d+\.\d+\.\d+', version), 'Invalid release version'
marketplace = root / 'dist' / 'marketplace'
plugin = marketplace / 'plugins' / 'chat-organizer'
assert json.loads((plugin / 'plugin.json').read_text(encoding='utf-8'))['version'] == version
assert (plugin / 'maintenance-workflow.js').read_bytes() == (root / 'maintenance-workflow.js').read_bytes()
output = root / 'dist' / 'release'
output.mkdir(parents=True, exist_ok=True)

source_files = [
    '.gitattributes', '.gitignore', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'plugin.json', 'mcp.json',
    'server.mjs', 'store.mjs', 'activity-refresh.mjs', 'maintenance-sources.mjs',
    'maintenance-workflow.js', 'trash-archive-workflow.js',
]
paths = [root / name for name in source_files]
for name in ['assets', 'docs', 'public', 'scripts', 'tests', '.github']:
    paths.extend(path for path in (root / name).rglob('*') if path.is_file())

def archive(base, files, prefix, name):
    target = output / name
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        for path in sorted(files):
            relative = path.relative_to(base)
            assert not path.is_symlink(), relative
            assert not any(part in ['node_modules', 'catalog', 'backups', '.git', '__pycache__'] for part in relative.parts), relative
            assert path.suffix.lower() not in ['.sqlite', '.db', '.log', '.jsonl', '.pyc'], relative
            entry = zipfile.ZipInfo(f'{prefix}/{relative.as_posix()}', (2000, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            package.writestr(entry, path.read_bytes(), compresslevel=9)
    with zipfile.ZipFile(target) as package:
        assert package.testzip() is None
        if prefix == 'chat-organizer-plugin':
            assert f'{prefix}/.agents/plugins/marketplace.json' in package.namelist()
            assert f'{prefix}/tools/import-export.mjs' in package.namelist()
    return target

artifacts = [
    archive(root, paths, 'chat-organizer', f'chat-organizer-{version}-source.zip'),
    archive(marketplace, [p for p in marketplace.rglob('*') if p.is_file()],
            'chat-organizer-plugin', f'chat-organizer-{version}-plugin.zip'),
]
guide = output / 'user-guide.html'
shutil.copyfile(root / 'docs' / 'user-guide.html', guide)
artifacts.append(guide)
checksums = ''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in artifacts)
(output / 'SHA256SUMS.txt').write_text(checksums, encoding='utf-8', newline='\n')
print(json.dumps({'version': version, 'assets': [p.name for p in artifacts] + ['SHA256SUMS.txt']}))
