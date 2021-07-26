import type { AstroConfig, BuildOptions } from '../@types/astro';

import del from 'del';
import fs from 'fs';
import vite from 'vite';
import { fileURLToPath } from 'url';
import ssr from '../ssr/index.js';
import { buildURLMap } from '../ssr/util.js';
import astroPlugin from '../ssr/vite_astro.js';
import { ASTRO_RUNTIME_DEPS, CJS_MODULES, ES_MODULES } from '../ssr/modules.js';
import { getUserDeps } from '../util.js';
import { warn } from '../logger.js';

type ReturnCode = number;

const FRONTEND_DIR = new URL('../frontend/hydrate/', import.meta.url);

/** `astro build` */
export default async function build(config: AstroConfig, options: BuildOptions): Promise<ReturnCode> {
  let urlMap = await buildURLMap(config.pages);
  const port = config.devOptions.port;
  if (!config.buildOptions.site) {
    warn(options.logging, 'config', `Set "buildOptions.site" to generate correct canonical URLs and sitemap`);
  }
  let origin = config.buildOptions.site ? new URL(config.buildOptions.site).origin : `http://localhost:${port}`;
  const entries: Record<string, string> = {};
  const buildCache = new URL('./.astro-cache/', config.projectRoot);

  // create server
  const viteConfig: vite.InlineConfig & { ssr?: { external?: string[]; noExternal?: string[] } } = {
    mode: 'production',
    logLevel: 'error',
    optimizeDeps: {
      entries: ['**/*'],
      include: [...ASTRO_RUNTIME_DEPS],
    },
    plugins: [
      astroPlugin({
        astroConfig: config,
        logging: options.logging,
        mode: 'production',
      }),
    ],
    publicDir: fileURLToPath(config.public),
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    root: fileURLToPath(config.projectRoot),
    server: {
      fs: { strict: false },
      hmr: { overlay: false },
      middlewareMode: 'ssr',
    },
    ssr: {
      external: [...CJS_MODULES],
      noExternal: [...ES_MODULES, ...(await getUserDeps(config.projectRoot))],
    },
  };
  const [viteServer] = await Promise.all([vite.createServer(viteConfig), del(fileURLToPath(buildCache))]);

  // write static HTML to disk
  await Promise.all(
    [...urlMap.staticPages.entries()].map(async ([k, v]) => {
      if (!k.endsWith('.html')) return; // urlMap contains many duplicate aliases; only build full paths with file extensions
      const html = await ssr({ config, logging: options.logging, mode: 'production', reqURL: k, origin, urlMap, viteServer });
      const filePath = new URL(k.replace(/^\//, './'), buildCache);
      await fs.promises.mkdir(new URL('./', filePath), { recursive: true });
      await fs.promises.writeFile(filePath, html, 'utf8');
      const entryID = k === '/index.html' ? 'index' : k.replace(/^\//, '').replace(/\/index\.html$/, '');
      entries[entryID] = fileURLToPath(filePath);
    })
  );

  // write collection HTML to disk

  // build
  await vite.build({
    define: {},
    mode: 'production',
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      minify: 'esbuild',
      rollupOptions: {
        input: entries,
        output: {
          format: 'esm',
        },
      },
      target: 'es2020',
      watch: null,
    },
    root: fileURLToPath(buildCache),
    server: viteConfig.server,
    plugins: viteConfig.plugins,
  });

  return 0;
}
