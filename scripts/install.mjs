import { access, readFile, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, delimiter, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { installPack, validatePack, packageRoot, defaultHome } from '../lib/pack.js';

const args = process.argv.slice(2);
let profile = 'web', display;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile') {
    profile = args[++i];
    if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Некорректный профиль');
  } else if (args[i] === '--display') {
    display = args[++i];
    if (!['web','desktop','both','none'].includes(display)) throw new Error('Режим: web, desktop, both или none');
  } else if (!['--check','--settings-only'].includes(args[i])) throw new Error(`Неизвестный параметр: ${args[i]}`);
}
validatePack();
const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const tar = join(packageRoot, `bea-harness-pet-${version}.tgz`);
await access(tar, constants.R_OK);
if (args.includes('--check')) {
  console.log('Беа 2.0: настройки и все 8 прозрачных анимаций готовы.');
  process.exit(0);
}
let cli;
if (!args.includes('--settings-only')) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    try { await access(candidate); cli = candidate; break; } catch {}
  }
  if (!cli) throw new Error('Запусти команду npm exec из README.md.');
}
const result = installPack({ display });
if (cli) {
  // Keep the source archive at a stable, short path. Some package-manager stores
  // turn long absolute file URLs into filenames exceeding the filesystem limit.
  const packages = join(defaultHome(), 'dsh-pet', 'packages');
  await mkdir(packages, { recursive: true });
  const localTar = join(packages, basename(tar));
  await copyFile(tar, localTar);
  const runPlugin = extra => new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, 'plugin', '--profile', profile, ...extra], { stdio:'inherit', env:process.env });
    child.once('error', reject);
    child.once('exit', code => done(code ?? 1));
  });
  let current;
  try { current = JSON.parse(await readFile(join(defaultHome(), 'profiles', profile, 'package.json'), 'utf8')); } catch {}
  if (current?.dependencies?.['dsh-pet']) {
    // The Bea bundle already activates dsh-pet. Remove its standalone profile
    // registration to avoid loading the same engine twice; user assets stay.
    const removed = await runPlugin(['remove', 'dsh-pet']);
    if (removed !== 0) throw new Error('Не удалось убрать отдельное подключение dsh-pet. Данные питомцев сохранены.');
  }
  const code = await runPlugin(['add', localTar]);
  if (code !== 0) throw new Error('Менеджер плагинов не завершил установку. Комплект анимаций уже скопирован; повтори команду.');
}
console.log(`Беа 2.0 ${cli ? 'установлена' : 'импортирована'}. Настройки: ${result.target}`);
if (result.separate) console.log('Беа добавлена отдельным питомцем; существующие питомцы сохранены.');
console.log('Перезапусти Harness и обнови страницу. В Chromium доступен прозрачный фон; на Linux режим desktop/both использует Electron.');
