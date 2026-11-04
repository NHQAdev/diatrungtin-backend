// Admin account management from the server's shell. There is no public sign-up for admins
// and no default password: the operator types one, or passes it via ADMIN_PASSWORD for automation.
//
//   npm run admin -- create --email owner@shop.vn --name "Chủ cửa hàng"
//   npm run admin -- reset-password --email owner@shop.vn
//   npm run admin -- disable --email staff@shop.vn
//
// reset-password and disable also revoke every open session of that account.

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { hashPassword, validatePasswordStrength } from '../src/lib/password.js';
import { normalizeEmail } from '../src/modules/admin-auth/admin-auth.service.js';
import { writeAuditLog } from '../src/modules/audit/audit.service.js';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const writer = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WriteStream };
    writer._writeToOutput = (text: string) => {
      // Echo the prompt itself, mask everything typed after it.
      writer.output.write(text.startsWith(question) ? question : '*'.repeat(text.length ? 1 : 0));
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readNewPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD;
  const password = fromEnv ?? (await promptHidden('Mật khẩu mới: '));
  const problem = validatePasswordStrength(password);
  if (problem) throw new Error(problem);
  if (!fromEnv && (await promptHidden('Nhập lại mật khẩu: ')) !== password) throw new Error('Hai lần nhập không khớp.');
  return password;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: 'string' }, name: { type: 'string' } },
});
const command = positionals[0];
const email = values.email ? normalizeEmail(values.email) : undefined;

const env = loadEnv();
const db = createDb(env.DATABASE_URL, 1);

try {
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('Thiếu hoặc sai --email.');

  if (command === 'create') {
    if (!values.name?.trim()) throw new Error('Thiếu --name.');
    const passwordHash = await hashPassword(await readNewPassword());
    const created = await db
      .insertInto('admin_users')
      .values({ email, display_name: values.name.trim(), password_hash: passwordHash })
      .onConflict((oc) => oc.column('email').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!created) throw new Error(`Đã có tài khoản ${email}. Dùng reset-password nếu cần đổi mật khẩu.`);
    await writeAuditLog(db, { actor_type: 'system', actor_id: null, action: 'admin.created_via_cli', entity_type: 'admin_user', entity_id: created.id });
    console.log(`Đã tạo tài khoản quản trị ${email}.`);
  } else if (command === 'reset-password' || command === 'disable') {
    const user = await db.selectFrom('admin_users').select('id').where('email', '=', email).executeTakeFirst();
    if (!user) throw new Error(`Không có tài khoản ${email}.`);
    const update =
      command === 'disable'
        ? { status: 'disabled' as const }
        : { password_hash: await hashPassword(await readNewPassword()), status: 'active' as const };
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('admin_users').set({ ...update, updated_at: sql`now()` }).where('id', '=', user.id).execute();
      await trx.updateTable('admin_sessions').set({ revoked_at: sql`now()` }).where('admin_user_id', '=', user.id).where('revoked_at', 'is', null).execute();
      await writeAuditLog(trx, { actor_type: 'system', actor_id: null, action: `admin.${command.replace('-', '_')}_via_cli`, entity_type: 'admin_user', entity_id: user.id });
    });
    console.log(command === 'disable' ? `Đã khóa ${email}.` : `Đã đổi mật khẩu cho ${email}.`);
    console.log('Mọi phiên đăng nhập cũ của tài khoản này đã bị thu hồi.');
  } else {
    throw new Error('Lệnh hợp lệ: create | reset-password | disable');
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
