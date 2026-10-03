import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { installPack } from './pack.js';
export const name = 'bea-assets';
export function apply() { installPack({ home: resolveDshHome(), refreshAnimations: false }); }
