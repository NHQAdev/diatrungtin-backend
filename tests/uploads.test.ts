import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCookie, call } from './fixtures.js';
import { createTestContext, resetData } from './helpers.js';

const ctx = await createTestContext();
const { app, db } = ctx;
let admin: string;

// Smallest valid PNG (1×1 pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Builds a multipart/form-data body by hand, like a browser form with one file field. */
function multipart(fileName: string, contentType: string, content: Buffer) {
  const boundary = '----dtt-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(fileName: string, contentType: string, content: Buffer, cookie: string | null = admin) {
  const { payload, headers } = multipart(fileName, contentType, content);
  return app.inject({ method: 'POST', url: '/api/admin/uploads', payload, headers: { ...headers, ...(cookie ? { cookie } : {}) } });
}

beforeEach(async () => {
  await resetData(db);
  admin = await adminCookie(app, db);
});
afterAll(async () => {
  await ctx.close();
});

describe('image upload', () => {
  it('stores a PNG under a random name and serves it back', async () => {
    const response = await upload('vong-tay.png', 'image/png', PNG);
    expect(response.statusCode).toBe(201);
    const url: string = response.json().data.url;
    expect(url).toMatch(/^http:\/\/localhost:4000\/uploads\/[0-9a-f-]{36}\.png$/);

    const file = await call(app, { url: new URL(url).pathname });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cache-control']).toMatch('immutable');
    expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.compare(file.rawPayload, PNG)).toBe(0);
  });

  it('checks the real content, not the file name or declared type', async () => {
    const fake = await upload('anh.png', 'image/png', Buffer.from('<script>alert(1)</script>'));
    expect(fake.statusCode).toBe(400);
    // A real PNG sent with a misleading name is stored as .png.
    const renamed = await upload('photo.jpg', 'image/jpeg', PNG);
    expect(renamed.json().data.url).toMatch(/\.png$/);
  });

  it('refuses files above the size limit', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(1.5 * 1024 * 1024)]);
    const response = await upload('big.png', 'image/png', big);
    expect(response.statusCode).toBe(413);
  });

  it('requires an admin session', async () => {
    expect((await upload('a.png', 'image/png', PNG, null)).statusCode).toBe(401);
  });

  it('never serves files outside the upload folder', async () => {
    for (const path of ['/uploads/..%2F..%2Fetc%2Fpasswd', '/uploads/package.json', '/uploads/00000000-0000-0000-0000-000000000000.png']) {
      expect((await call(app, { url: path })).statusCode).toBe(404);
    }
  });
});
