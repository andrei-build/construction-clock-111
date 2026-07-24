// MAIL-2: mail-send — отправка письма с корпоративного ящика через SMTP (465, implicit TLS).
// Вход: { account_key: 'buildpro'|'customhomes', to: string, subject: string, body: string, in_reply_to?: string }
// Авторизация: Bearer JWT роли owner/admin ИЛИ x-mail-token (служебный, для смоуков).
// Пароль — тот же секрет MAIL_<KEY>_PASS, что у mail-sync. Исходящее пишется в mail_messages (direction='out').
// v7 (24.07, Бета-8, хвост 5): бренд-строки — EHLO marvelconstruction.app (был constructionclock.app),
//                     Message-ID префикс mc- (был cc-). Логика не тронута. Откат: v6.
// FIX 20.07 (Бета-6): профиль ищется по .eq('id', uid) (PK profiles), а не по несуществующей user_id;
//                     events-инсерт приведён к реальным колонкам (event_type/entity_type/data).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

class Smtp {
  private conn!: Deno.TlsConn;
  private buf = new Uint8Array(0);
  private dec = new TextDecoder();

  async connect(host: string, port: number) {
    this.conn = await Deno.connectTls({ hostname: host, port });
    await this.expect('220');
  }
  private async fill(): Promise<boolean> {
    const chunk = new Uint8Array(8192);
    const n = await this.conn.read(chunk);
    if (n === null) return false;
    const nb = new Uint8Array(this.buf.length + n);
    nb.set(this.buf); nb.set(chunk.subarray(0, n), this.buf.length);
    this.buf = nb;
    return true;
  }
  // читаем ПОЛНЫЙ ответ (многострочные 250-... до финальной строки без дефиса)
  async readReply(): Promise<string> {
    let out = '';
    for (;;) {
      const idx = this.buf.indexOf(10);
      if (idx < 0) { if (!(await this.fill())) throw new Error('SMTP: соединение закрыто'); continue; }
      const line = this.dec.decode(this.buf.subarray(0, idx + 1));
      this.buf = this.buf.subarray(idx + 1);
      out += line;
      const l = line.replace(/\r?\n$/, '');
      if (/^\d{3} /.test(l)) return out;
    }
  }
  private async write(s: string) {
    const enc = new TextEncoder().encode(s);
    let off = 0;
    while (off < enc.length) off += await this.conn.write(enc.subarray(off));
  }
  async cmd(c: string): Promise<string> { await this.write(c + '\r\n'); return await this.readReply(); }
  async expect(code: string, c?: string): Promise<string> {
    const r = c === undefined ? await this.readReply() : await this.cmd(c);
    if (!r.startsWith(code)) throw new Error('SMTP ' + (c ? c.split(' ')[0] : 'greeting') + ': ' + r.trim().split('\n').pop());
    return r;
  }
  async close() { try { await this.cmd('QUIT'); } catch (_) { /* ignore */ } try { this.conn.close(); } catch (_) { /* ignore */ } }
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const encWord = (s: string) => /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;

function buildMessage(fromName: string, fromAddr: string, to: string, subject: string, body: string, inReplyTo?: string): string {
  const now = new Date().toUTCString().replace('GMT', '+0000');
  const msgId = `<mc-${crypto.randomUUID()}@${fromAddr.split('@')[1]}>`;
  const b64body = b64(body).replace(/(.{76})/g, '$1\r\n');
  const headers = [
    `From: ${encWord(fromName)} <${fromAddr}>`,
    `To: ${to}`,
    `Subject: ${encWord(subject)}`,
    `Date: ${now}`,
    `Message-ID: ${msgId}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    inReplyTo ? `References: ${inReplyTo}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  return headers.join('\r\n') + '\r\n\r\n' + b64body + '\r\n';
}

Deno.serve(async (req: Request) => {
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // --- авторизация (owner/admin или служебный токен) ---
  let allowed = false, senderId: string | null = null;
  const token = req.headers.get('x-mail-token');
  if (token) {
    const { data } = await svc.from('app_settings').select('settings').limit(1).maybeSingle();
    if (data?.settings?.mail_sync_token && data.settings.mail_sync_token === token) allowed = true;
  }
  if (!allowed) {
    const auth = req.headers.get('Authorization') ?? '';
    if (auth.startsWith('Bearer ')) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
      const { data: u } = await userClient.auth.getUser();
      if (u?.user) {
        const { data: prof } = await svc.from('profiles').select('role').eq('id', u.user.id).maybeSingle();
        if (prof && ['owner', 'admin'].includes(String(prof.role))) { allowed = true; senderId = u.user.id; }
      }
    }
  }
  if (!allowed) return json({ error: 'forbidden' }, 403);

  // --- вход ---
  let p: { account_key?: string; to?: string; subject?: string; body?: string; in_reply_to?: string };
  try { p = await req.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const { account_key, to, subject, body, in_reply_to } = p;
  if (!account_key || !to || !subject || !body) return json({ error: 'нужны account_key, to, subject, body' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: 'кривой адрес to' }, 400);

  const { data: acc } = await svc.from('mail_accounts').select('*').eq('key', account_key).maybeSingle();
  if (!acc) return json({ error: 'ящик не найден' }, 404);
  const pass = Deno.env.get(`MAIL_${String(acc.key).toUpperCase()}_PASS`);
  if (!acc.smtp_host || !pass) return json({ error: 'нет SMTP-реквизитов или пароля' }, 500);

  const smtp = new Smtp();
  try {
    await smtp.connect(acc.smtp_host, Number(acc.smtp_port) || 465);
    await smtp.expect('250', 'EHLO marvelconstruction.app');
    await smtp.expect('334', 'AUTH LOGIN');
    await smtp.expect('334', b64(acc.email));
    await smtp.expect('235', b64(pass));
    await smtp.expect('250', `MAIL FROM:<${acc.email}>`);
    await smtp.expect('250', `RCPT TO:<${to}>`);
    await smtp.expect('354', 'DATA');
    const msg = buildMessage(acc.display_name || acc.email, acc.email, to, subject, body, in_reply_to);
    // dot-stuffing
    const stuffed = msg.replace(/\r\n\./g, '\r\n..');
    const fin = await smtp.cmd(stuffed + '.');
    if (!fin.startsWith('250')) throw new Error('SMTP DATA: ' + fin.trim());

    await svc.from('mail_messages').insert({
      org_id: acc.org_id,
      account_id: acc.id,
      uid: null,
      direction: 'out',
      from_name: acc.display_name || null,
      from_addr: acc.email,
      to_addr: to,
      subject,
      snippet: body.slice(0, 400),
      body_text: body.slice(0, 4000),
      sent_at: new Date().toISOString(),
      seen: true,
    });
    // след в журнале (ядро №4): кто отправил — реальные колонки events (event_type/entity_type/data)
    try { await svc.from('events').insert({ org_id: acc.org_id, event_type: 'mail.sent', entity_type: 'mail', actor_id: senderId, data: { account: acc.key, to, subject: subject.slice(0, 120) } }); } catch (_) { /* некритично */ }
    return json({ ok: true, from: acc.email, to });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  } finally {
    await smtp.close();
  }
});
