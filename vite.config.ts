import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

/**
 * Serves the Vercel functions in api/*.ts from the Vite dev server, so `npm run dev` behaves
 * like production. Storage falls back to .data/bundle.bin (see server/storage.ts). Fill it with
 * `npm run ingest` (live sources) or `npm run seed:demo` (offline).
 */
function devApi(): Plugin {
  return {
    name: 'bura-dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const m = url.pathname.match(/^\/api\/(frames|field|ingest)$/);
        if (!m) return next();
        try {
          const mod = await server.ssrLoadModule(`/api/${m[1]}.ts`);
          const handler = mod[req.method ?? 'GET'] ?? mod.GET;
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const response: Response = await handler(new Request(url, { method: req.method, headers }));
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          console.error(err);
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [devApi()],
  build: {
    target: 'es2022',
    sourcemap: true,
    reportCompressedSize: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
} as any);
