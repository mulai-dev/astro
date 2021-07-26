import type { SourceDescription } from 'rollup';
import type { Plugin } from 'vite';
import type { RuntimeMode } from '../@types/astro';
import type { CompileOptions } from '../@types/compiler';

import fs from 'fs';
import path from 'path';
import slash from 'slash';
import { fileURLToPath } from 'url';
import { compileComponent } from '../compiler/index.js';

const ASTRO_CSS = 'astro_core:css';
const devCSSCache = new Map<string, SourceDescription>();

/** Allow Vite to load .astro files */
export default function astro(compileOptions: CompileOptions): Plugin {
  const buildCache = new URL('./.astro-cache/', compileOptions.astroConfig.projectRoot);
  const buildCSSCache = new URL('./css/', buildCache);
  let mode: RuntimeMode = 'development';

  return {
    name: '@astrojs/plugin-vite',
    enforce: 'pre', // we want to load .astro files before anything else can!
    configResolved(config) {
      mode = config.mode as RuntimeMode;
    },
    resolveId(id) {
      if (id.startsWith(ASTRO_CSS)) return id;
      return null;
    },
    async load(id) {
      if (id.endsWith('__astro_component.js')) {
        let code: string[] = [];
        let rendererNames = compileOptions.astroConfig.renderers || [];
        const rendererInstances = await Promise.all(rendererNames.map((name) => import(name).then((m) => m.default)));
        rendererInstances.forEach((renderer, n) => {
          code.push(`import __renderer_${n} from '${renderer.name}${renderer.server.replace(/^\./, '')}';`); // note: even if import statements are written out-of-order, "n" will still be in array order
        });
        code.push(`const rendererInstances = [`);
        rendererInstances.forEach((renderer, n) => {
          code.push(`  { source: '${renderer.name}${renderer.client.replace(/^\./, '')}', renderer: __renderer_${n}, polyfills: [], hydrationPolyfills: [] },`);
        });
        code.push(`];`);
        return code.join('\n') + '\n' + (await fs.promises.readFile(id, 'utf8'));
      }
      if (id.endsWith('.astro') || id.endsWith('.md')) {
        const src = await fs.promises.readFile(id, 'utf8');
        const result = await compileComponent(src, {
          compileOptions,
          filename: id,
          projectRoot: fileURLToPath(compileOptions.astroConfig.projectRoot),
        });
        let code = result.contents;
        if (result.css && result.css.code) {
          const cssID = `${slash(id).replace(compileOptions.astroConfig.projectRoot.pathname, '/')}.css`;
          // prod: serve from filesystem (easier to run multiple optimization passes on)
          if (mode === 'production') {
            const filePath = new URL(`.${cssID}`, buildCSSCache);
            const relPath = path.posix.relative(slash(path.dirname(id)), fileURLToPath(buildCSSCache));
            await fs.promises.mkdir(new URL('./', filePath), { recursive: true });
            await fs.promises.writeFile(filePath, result.css.code, 'utf8');
            if (result.css.map) await fs.promises.writeFile(filePath + '.map', result.css.map.toString(), 'utf8');
            code += `import '${relPath}${cssID}'\n;`;
          }
          // dev: serve from memory
          else {
            devCSSCache.set(cssID, result.css);
            code += `import '${ASTRO_CSS}${cssID}'\n;`;
          }
        }
        return code;
      }
      // dev-only: serve from memory
      if (id.startsWith(ASTRO_CSS)) {
        return devCSSCache.get(slash(id).replace(ASTRO_CSS, '')) || null;
      }
      return null;
    },
  };
}
