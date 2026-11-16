import { build } from 'esbuild';
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const marketplace = resolve(dist, 'marketplace');
const plugin = join(marketplace, 'plugins', 'chat-organizer');
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

// Only generated output inside this repository may be replaced.
const outputRelative = relative(dist, marketplace);
if (!outputRelative || outputRelative.startsWith('..') || isAbsolute(outputRelative)) {
  throw new Error('Build output must be contained in the repository dist directory.');
}
await rm(marketplace, { recursive: true, force: true });
await mkdir(join(plugin, 'public'), { recursive: true });
await mkdir(join(plugin, 'assets'), { recursive: true });
await mkdir(join(marketplace, 'tools'), { recursive: true });

const buildOptions = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  metafile: true,
  legalComments: 'eof',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
};
const result = await build({
  ...buildOptions,
  entryPoints: ['server.mjs'],
  outfile: join(plugin, 'bundle.mjs'),
});
const importer = await build({
  ...buildOptions,
  entryPoints: ['scripts/import-export.mjs'],
  outfile: join(marketplace, 'tools', 'import-export.mjs'),
});

for (const name of ['plugin.json', 'mcp.json', 'maintenance-workflow.js', 'trash-archive-workflow.js', 'LICENSE']) {
  await copyFile(join(root, name), join(plugin, name));
}
await copyFile(join(root, 'public', 'organizer.html'), join(plugin, 'public', 'organizer.html'));
for (const name of ['icon.png', 'icon.svg']) {
  await copyFile(join(root, 'assets', name), join(plugin, 'assets', name));
}
await copyFile(join(root, 'LICENSE'), join(marketplace, 'LICENSE'));
await copyFile(join(root, 'README.md'), join(marketplace, 'README.md'));
await cp(join(root, 'docs'), join(marketplace, 'docs'), { recursive: true });

async function packageFor(input) {
  let directory = dirname(resolve(root, input));
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name && manifest.version) return { directory, manifest };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    directory = dirname(directory);
  }
  throw new Error('Cannot identify a bundled dependency.');
}

const dependencies = new Map();
const bundledInputs = Object.keys({ ...result.metafile.inputs, ...importer.metafile.inputs });
for (const input of bundledInputs.filter(input => input.replaceAll('\\', '/').includes('node_modules/'))) {
  const entry = await packageFor(input);
  dependencies.set(entry.manifest.name + '@' + entry.manifest.version, entry);
}
const notices = [
  'Third-party notices for Chat Organizer ' + packageInfo.version,
  '',
  'The bundled server contains the following dependencies. Their license terms follow.',
];
for (const [name, { directory, manifest }] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
  notices.push('', '======== ' + name + ' ========', 'License: ' + (manifest.license || 'See terms below'));
  const files = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)([._-].*)?$/i.test(name)).sort();
  if (!files.length) throw new Error('No license text found for bundled dependency ' + name);
  for (const file of files) notices.push('', file, '', await readFile(join(directory, file), 'utf8'));
}
await writeFile(join(plugin, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n') + '\n');
await writeFile(join(marketplace, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n') + '\n');

await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true });
await writeFile(join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
  name: 'chat-organizer-community',
  interface: { displayName: 'Chat Organizer Community' },
  plugins: [{
    name: 'chat-organizer',
    source: { source: 'local', path: './plugins/chat-organizer' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  }],
}, null, 2) + '\n');

console.log(JSON.stringify({
  version: packageInfo.version,
  marketplace: relative(root, marketplace),
  plugin: relative(root, plugin),
  bundledDependencyCount: dependencies.size,
}));
