import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireAdmin } from '../admin-auth/require-admin.js';

// Product images are stored on the server's disk (UPLOAD_DIR) and served from /uploads/<file>.
// Back up UPLOAD_DIR together with the database. Moving to S3-compatible storage later only
// changes this file.

const FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Decide the image type from the file's first bytes, not from the name the browser sent. */
function detectImageType(buffer: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function uploadRoutes(deps: { db: Db; env: Env }) {
  const { db, env } = deps;
  const uploadDir = path.resolve(env.UPLOAD_DIR);

  return async function register(app: FastifyInstance) {
    await app.register(multipart, { limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1, fields: 5 } });

    app.post('/api/admin/uploads', { preHandler: requireAdmin(db) }, async (request, reply) => {
      const file = await request.file();
      if (!file) throw badRequest('Vui lòng chọn một file ảnh.');

      // toBuffer() throws (413) if the file is larger than UPLOAD_MAX_MB.
      const buffer = await file.toBuffer();
      const type = detectImageType(buffer);
      if (!type) throw badRequest('Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP.');

      const fileName = `${randomUUID()}.${type}`;
      await mkdir(uploadDir, { recursive: true });
      await writeFile(path.join(uploadDir, fileName), buffer);

      request.log.info({ fileName, bytes: buffer.length, admin: request.admin!.id }, 'image uploaded');
      return reply.status(201).send({ data: { url: `${env.API_PUBLIC_URL.replace(/\/$/, '')}/uploads/${fileName}` } });
    });

    app.get('/uploads/:fileName', async (request, reply) => {
      const { fileName } = z.object({ fileName: z.string() }).parse(request.params);
      // Strict name check: also blocks "../" path tricks.
      if (!FILE_NAME.test(fileName)) throw notFound('Không tìm thấy ảnh.');

      const filePath = path.join(uploadDir, fileName);
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) throw notFound('Không tìm thấy ảnh.');

      const extension = fileName.split('.').pop()!;
      return reply
        .header('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream')
        .header('Content-Length', info.size)
        // File names are random and never reused, so browsers may cache them forever.
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(createReadStream(filePath));
    });
  };
}
