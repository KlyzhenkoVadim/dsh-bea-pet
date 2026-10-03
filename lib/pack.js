import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function defaultHome() {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? resolve(configured === '~' ? homedir() : /^~[\\/]/.test(configured) ? join(homedir(), configured.slice(2)) : configured) : join(homedir(), '.dsh');
}
function parseJsonc(text) {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; out += c; }
    else if (c === '/' && text[i+1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i+1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i+1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out);
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, value);
  renameSync(tmp, path);
}
function backup(path) {
  if (existsSync(path)) copyFileSync(path, `${path}.backup-${Date.now()}-${randomUUID()}`);
}
export function validatePack(root = packageRoot) {
  const config = JSON.parse(readFileSync(join(root, 'settings/bea-config.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'assets/bea-video/manifest.json'), 'utf8'));
  const names = new Set(manifest.clips.map(c => c.name));
  const a = config.animations;
  const refs = [...a.idle, ...a.turn, ...a.drag, ...a.clicks, ...a.moves.actions.map(x => x.name), ...a.categories.flatMap(x => x.actions), ...Object.values(a.events).flat(2)];
  for (const ref of refs) {
    if (!names.has(ref) || !existsSync(join(root, 'assets/bea-video', `${ref}.webm`))) throw new Error(`Отсутствует анимация ${ref}`);
  }
  if (manifest.fps !== 30 || manifest.width !== 640 || manifest.height !== 360 || config.pets[0].id !== 'bea-brawl-stars') throw new Error('Неверный формат комплекта Беа');
  return config;
}
export function installPack({ home = defaultHome(), display, root = packageRoot, refreshAnimations = true } = {}) {
  const base = validatePack(root);
  const directory = join(home, 'dsh-pet');
  const main = join(directory, 'main-config.jsonc');
  const legacyMain = join(directory, 'main-config.json');
  const currentPath = existsSync(main) ? main : legacyMain;
  const currentText = existsSync(currentPath) ? readFileSync(currentPath, 'utf8') : '';
  // A pre-existing unrelated pet remains intact: Bea gets a separate asset root.
  const separate = !!currentText && !/"id"\s*:\s*"bea-brawl-stars"/.test(currentText);
  const target = separate ? join(directory, 'pet/bea-config.json') : main;
  const videoTarget = separate ? join(directory, 'pet/bea-animation') : join(directory, 'main-animation/webm');
  mkdirSync(videoTarget, { recursive: true });
  for (const clip of readdirSync(join(root, 'assets/bea-video')).filter(x => x.endsWith('.webm'))) {
    const source = readFileSync(join(root, 'assets/bea-video', clip));
    const dest = join(videoTarget, clip);
    if (!existsSync(dest) || !readFileSync(dest).equals(source)) atomic(dest, source);
  }
  let previous;
  if (existsSync(target)) previous = parseJsonc(readFileSync(target, 'utf8'));
  const pet = previous?.pets?.find(p => p.id === 'bea-brawl-stars');
  const config = { ...base, ...previous, ...(refreshAnimations ? { animations: base.animations, animationWeights: base.animationWeights } : {}),
    pets: [ { ...base.pets[0], ...pet, ...(display ? { display } : {}) }, ...(previous?.pets ?? []).filter(p => p.id !== 'bea-brawl-stars') ] };
  const body = JSON.stringify(config, null, 2) + '\n';
  if (!existsSync(target) || readFileSync(target, 'utf8') !== body) { backup(target); atomic(target, body); }
  return { target, separate };
}
