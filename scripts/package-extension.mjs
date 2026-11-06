import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [serial, commit, output] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(serial) || !/^[0-9a-f]{40}$/.test(commit) || !output) {
  throw new Error('Usage: package-extension.mjs BUILD COMMIT OUTPUT');
}
const root = fileURLToPath(new URL('../extension/', import.meta.url));
const files = {};
async function collect(dir = '') {
  for (const item of await readdir(join(root, dir), { withFileTypes: true })) {
    const name = dir ? dir + '/' + item.name : item.name;
    if (item.isDirectory()) await collect(name);
    else if (item.isFile()) {
      let bytes = await readFile(join(root, name));
      if (name === 'manifest.json') {
        const manifest = JSON.parse(bytes);
        manifest.version_name = 'auto-' + serial;
        bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      }
      files[name] = bytes.toString('base64');
    } else throw new Error('Unexpected file type: ' + name);
  }
}
await collect();
await writeFile(output, JSON.stringify({ serial: Number(serial), commit, files }));
