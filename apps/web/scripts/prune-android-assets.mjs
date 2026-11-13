/**
 * After `cap sync android`: drop what the app does not need from the copied web build –
 *  - source maps and the service worker;
 *  - models/ (≈ 95 MB): the app downloads the photo-helper models from the control-room server in “Ready for offline”;
 *  - assets/*.wasm: an unused second copy of the ONNX runtime (the app loads it from ort/, which stays).
 */
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'android/app/src/main/assets/public';
let freed = 0;
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (f.endsWith('.map') || f === 'sw.js' || (d.endsWith('assets') && f.endsWith('.wasm'))) {
      freed += s.size;
      unlinkSync(p);
    }
  }
};
walk(ROOT);
const models = join(ROOT, 'models');
if (existsSync(models)) {
  const size = (p) => (statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + size(join(p, f)), 0) : statSync(p).size);
  freed += size(models);
  rmSync(models, { recursive: true, force: true });
}
console.log(`pruned ${(freed / 1048576).toFixed(1)} MB from the app's web assets`);
