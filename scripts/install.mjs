import { readFile, mkdir, copyFile, writeFile, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const allowed = new Set(['--profile', '--settings-only', '--check']);
let profile = 'web';
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Неизвестный параметр: ${args[i]}`);
  if (args[i] === '--profile') {
    profile = args[++i];
    if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Некорректное имя профиля');
  }
}
if (profile === 'desktop') throw new Error('Этот комплект проверен для браузерного профиля web. Поддержка desktop пока не проверена.');

const settings = JSON.parse(await readFile(join(root, 'settings', 'preferences.json'), 'utf8'));
if (settings.version !== 3 || settings.selectedPetId !== 'bea-brawl-stars' ||
    typeof settings.awake !== 'boolean' || !Number.isInteger(settings.sizePx) ||
    settings.sizePx < 80 || settings.sizePx > 224 ||
    Object.keys(settings).some(k => !['version', 'selectedPetId', 'awake', 'sizePx'].includes(k))) {
  throw new Error('Файл настроек Беа не прошёл проверку');
}
await access(join(root, 'bea-harness-pet-1.0.0.tgz'), constants.R_OK);
if (args.includes('--check')) {
  console.log('Комплект Беа и настройки готовы к переносу.');
  process.exit(0);
}

if (!args.includes('--settings-only')) {
  // npm exec adds its installed packages to PATH. Launch Node directly so
  // paths with spaces work on macOS, Linux and Windows without shell quoting.
  let cli;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    try { await access(candidate, constants.R_OK); cli = candidate; break; } catch {}
  }
  if (!cli) throw new Error('Запусти установку командой npm exec из README.md.');
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, [cli, 'plugin', '--profile', profile, 'add',
      join(root, 'bea-harness-pet-1.0.0.tgz')], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => resolveCode(code ?? 1));
  });
  if (code !== 0) throw new Error('Установщик Harness завершился с ошибкой. Настройки Беа не изменены.');
}

const configured = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : undefined;
const home = configured ? resolve(configured === '~' ? homedir()
  : configured.startsWith('~/') || configured.startsWith('~\\')
    ? join(homedir(), configured.slice(2)) : configured) : join(homedir(), '.dsh');
const directory = join(home, 'bea-pet');
await mkdir(directory, { recursive: true });
const target = join(directory, 'preferences.json');
try {
  await access(target);
  await copyFile(target, `${target}.backup-${Date.now()}-${randomUUID()}`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const temp = `${target}.${randomUUID()}.tmp`;
await writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
await rename(temp, target);
console.log(args.includes('--settings-only') ? 'Настройки Беа импортированы.' : 'Беа установлена, настройки импортированы.');
console.log('Перезапусти Harness и обнови его страницу.');
