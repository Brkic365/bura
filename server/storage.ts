/**
 * Snapshot storage. The whole state is one binary object (~0.5 MB), written only when the content
 * changed: about once per hour for new DHMZ observations, plus once per model refresh. That
 * keeps Vercel Blob within the Hobby allowance (2,000 advanced operations a month).
 *
 * - BLOB_READ_WRITE_TOKEN set → Vercel Blob (public object `bura/bundle.bin`).
 * - otherwise → local file `.data/bundle.bin` (dev, tests, self-hosting).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface Storage {
  name: string;
  get(): Promise<Uint8Array | null>;
  put(bytes: Uint8Array): Promise<void>;
}

const PATHNAME = 'bura/bundle.bin';

export function fileStorage(path = resolve(process.cwd(), '.data/bundle.bin')): Storage {
  return {
    name: `file:${path}`,
    async get() {
      try {
        return new Uint8Array(await readFile(path));
      } catch (err: any) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
    },
    async put(bytes) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
  };
}

export function blobStorage(token: string): Storage {
  let url: string | null = process.env.BLOB_BUNDLE_URL ?? null;
  return {
    name: 'vercel-blob',
    async get() {
      const { head, BlobNotFoundError } = await import('@vercel/blob');
      if (!url) {
        try {
          url = (await head(PATHNAME, { token })).url;
        } catch (err) {
          if (err instanceof BlobNotFoundError) return null;
          throw err;
        }
      }
      // Bypass the blob CDN cache: an overwritten object can stay cached for up to a minute.
      const res = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`blob GET ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async put(bytes) {
      const { put } = await import('@vercel/blob');
      const r = await put(PATHNAME, Buffer.from(bytes), {
        access: 'public',
        token,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/octet-stream',
        cacheControlMaxAge: 60,
      });
      url = r.url;
    },
  };
}

export function defaultStorage(): Storage {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? blobStorage(token) : fileStorage();
}
