// MAIL-1..5: mail-sync v6 — IMAP → mail_messages. Режимы: off | allowlist | smart.
// v6 (19.07, Бета-6): фикс base64-огрызков в сниппетах (собственные исходящие, втянутые по IMAP):
// (1) санация base64 перед atob — частичный FETCH режет поток не по границе квартета, atob падал и в
// snippet уезжал сырой base64; теперь чистим не-base64 символы и обрезаем до кратности 4;
// (2) страховка rescueBase64: если итоговый текст всё ещё выглядит как чистый base64 — декодируем.
// v5 (17.07, Бета-5): треды (thread_key), body_html (BODYSTRUCTURE + выборочный FETCH), вложения.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

class Imap {
  private conn!: Deno.TlsConn;
  private buf = new Uint8Array(0);
  private tagN = 0;
  private dec = new TextDecoder();
  async connect(host: string, port: number) { this.conn = await Deno.connectTls({ hostname: host, port }); await this.readLine(); }
  private async fill(): Promise<boolean> {
    const chunk = new Uint8Array(16384);
    const n = await this.conn.read(chunk);
    if (n === null) return false;
    const nb = new Uint8Array(this.buf.length + n);
    nb.set(this.buf); nb.set(chunk.subarray(0, n), this.buf.length);
    this.buf = nb;
    return true;
  }
  async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buf.indexOf(10);
      if (idx >= 0) { const line = this.dec.decode(this.buf.subarray(0, idx + 1)); this.buf = this.buf.subarray(idx + 1); return line.replace(/\r?\n$/, ''); }
      if (!(await this.fill())) throw new Error('IMAP: соединение закрыто');
    }
  }
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) { if (!(await this.fill())) throw new Error('IMAP: соединение закрыто (literal)'); }
    const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return out;
  }
  private async write(s: string) { const enc = new TextEncoder().encode(s); let off = 0; while (off < enc.length) off += await this.conn.write(enc.subarray(off)); }
  async cmd(command: string): Promise<{ ok: boolean; lines: string[]; literals: Uint8Array[]; status: string }> {
    const tag = 'A' + (++this.tagN);
    await this.write(tag + ' ' + command + '\r\n');
    const lines: string[] = []; const literals: Uint8Array[] = [];
    for (;;) {
      let line = await this.readLine();
      let m = line.match(/\{(\d+)\}$/);
      while (m) {
        const size = parseInt(m[1], 10);
        literals.push(await this.readBytes(size));
        line = line.replace(/\{(\d+)\}$/, `<<LIT${literals.length - 1}>>`);
        line += await this.readLine();
        m = line.match(/\{(\d+)\}$/);
      }
      lines.push(line);
      if (line.startsWith(tag + ' ')) return { ok: line.startsWith(tag + ' OK'), lines, literals, status: line };
    }
  }
  quote(s: string): string { return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\\\"') + '"'; }
  async login(user: string, pass: string) { const r = await this.cmd('LOGIN ' + this.quote(user) + ' ' + this.quote(pass)); if (!r.ok) throw new Error('IMAP LOGIN отклонён: ' + r.status); }
  async close() { try { await this.cmd('LOGOUT'); } catch (_) { /* */ } try { this.conn.close(); } catch (_) { /* */ } }
}

// санация base64: выкинуть не-base64 символы, обрезать до кратности 4 (частичный FETCH режет поток)
function b64ToBytes(s: string): Uint8Array | null {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return null;
  const trimmed = clean.slice(0, clean.length - (clean.length % 4));
  try {
    const bin = atob(trimmed);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch (_) { return null; }
}

function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_all, cs, enc, data) => {
    try {
      let bytes: Uint8Array;
      if (enc.toLowerCase() === 'b') bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      else { const qp = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16))); bytes = Uint8Array.from(qp, (c: string) => c.charCodeAt(0) & 0xff); }
      return new TextDecoder(cs.toLowerCase()).decode(bytes);
    } catch (_) { return data; }
  }).replace(/\?=\s+=\?/g, '?==?');
}
function decodeQPBytes(s: string): Uint8Array {
  const bin = s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0) & 0xff);
}
function decodeQP(s: string): string {
  try { return new TextDecoder('utf-8').decode(decodeQPBytes(s)); } catch (_) { return s; }
}
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  return out;
}
function parseFrom(v: string): { name: string; addr: string } {
  const m = v.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: decodeWords(m[1].replace(/^"|"$/g, '').trim()), addr: m[2].trim() };
  return { name: '', addr: v.trim() };
}
// текст выглядит как чистый base64 (огрызок недодекодированного тела)?
function looksLikeBase64(t: string): boolean {
  const compact = t.replace(/\s+/g, '');
  if (compact.length < 120) return false;
  return /^[A-Za-z0-9+/=]+$/.test(compact);
}
function rescueBase64(t: string): string {
  if (!looksLikeBase64(t)) return t;
  const bytes = b64ToBytes(t);
  if (!bytes) return t;
  try {
    const dec = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const printable = dec.replace(/[^\p{L}\p{N}\p{P}\p{Z}\n\r\t]/gu, '');
    if (printable.length < dec.length * 0.7) return t; // бинарь, не текст
    const out = /<[a-z!][\s\S]*>/i.test(dec) ? htmlToText(dec) : dec;
    return out.trim() || t;
  } catch (_) { return t; }
}
function bodyToText(raw: string, cte?: string): string {
  let t = raw;
  if (cte && /base64/i.test(cte)) { const b = b64ToBytes(t); if (b) { try { t = new TextDecoder('utf-8').decode(b); } catch (_) { /* */ } } }
  t = t.replace(/^--[^\r\n]*$/gm, '\n');
  t = t.replace(/^(Content-[^:]+|MIME-Version):[^\r\n]*\r?\n?/gim, '');
  t = decodeQP(t);
  t = t.replace(/(?:^[A-Za-z0-9+/=]{60,}\r?\n?){4,}/gm, '[вложение]\n');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  t = t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*\n\s*(\n\s*)+/g, '\n\n').trim();
  return t;
}
function htmlToText(html: string): string {
  let t = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*\n\s*(\n\s*)+/g, '\n\n').trim();
}

type BSNode = string | number | null | BSNode[];
function tokenizeBS(s: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(' || c === ')') { toks.push(c); i++; continue; }
    if (c === ' ') { i++; continue; }
    if (c === '"') {
      let j = i + 1, out = '';
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2; } else { out += s[j]; j++; } }
      toks.push('"' + out); i = j + 1; continue;
    }
    let j = i;
    while (j < s.length && s[j] !== ' ' && s[j] !== '(' && s[j] !== ')') j++;
    toks.push(s.slice(i, j)); i = j;
  }
  return toks;
}
function parseBS(toks: string[], pos: { i: number }): BSNode {
  const t = toks[pos.i];
  if (t === '(') {
    pos.i++;
    const arr: BSNode[] = [];
    while (pos.i < toks.length && toks[pos.i] !== ')') arr.push(parseBS(toks, pos));
    pos.i++;
    return arr;
  }
  pos.i++;
  if (t === undefined) return null;
  if (t.startsWith('"')) return t.slice(1);
  if (/^NIL$/i.test(t)) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return t;
}
function paramsToMap(node: BSNode): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(node)) for (let i = 0; i + 1 < node.length; i += 2) {
    const k = node[i], v = node[i + 1];
    if (typeof k === 'string') out[k.toLowerCase()] = typeof v === 'string' ? v : String(v ?? '');
  }
  return out;
}
interface MimePart { path: string; type: string; subtype: string; params: Record<string, string>; encoding: string; size: number; filename: string | null; disposition: string | null }
function findDisposition(node: BSNode[]): { disp: string | null; params: Record<string, string> } {
  for (let i = node.length - 1; i >= 0; i--) {
    const el = node[i];
    if (Array.isArray(el) && el.length >= 1 && typeof el[0] === 'string' && /^(attachment|inline)$/i.test(el[0] as string)) {
      return { disp: (el[0] as string).toLowerCase(), params: paramsToMap(el[1] ?? null) };
    }
  }
  return { disp: null, params: {} };
}
function walkBS(node: BSNode, path: string, out: MimePart[]) {
  if (!Array.isArray(node)) return;
  if (Array.isArray(node[0])) {
    let idx = 0;
    while (idx < node.length && Array.isArray(node[idx])) {
      walkBS(node[idx], path ? `${path}.${idx + 1}` : String(idx + 1), out);
      idx++;
    }
    return;
  }
  const type = typeof node[0] === 'string' ? (node[0] as string).toLowerCase() : '';
  const subtype = typeof node[1] === 'string' ? (node[1] as string).toLowerCase() : '';
  const params = paramsToMap(node[2] ?? null);
  const encoding = typeof node[5] === 'string' ? (node[5] as string).toLowerCase() : '';
  const size = typeof node[6] === 'number' ? (node[6] as number) : 0;
  const { disp, params: dparams } = findDisposition(node);
  let filename = dparams['filename'] ?? params['name'] ?? null;
  if (filename) filename = decodeWords(filename);
  out.push({ path: path || '1', type, subtype, params, encoding, size, filename, disposition: disp });
}
function decodePartBytes(bytes: Uint8Array, encoding: string, charset: string): string {
  try {
    const ascii = new TextDecoder('latin1').decode(bytes);
    if (/base64/.test(encoding)) {
      const b = b64ToBytes(ascii);
      if (b) return new TextDecoder(charset || 'utf-8').decode(b);
      return new TextDecoder(charset || 'utf-8').decode(bytes);
    }
    if (/quoted-printable/.test(encoding)) {
      return new TextDecoder(charset || 'utf-8').decode(decodeQPBytes(ascii));
    }
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch (_) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch { return ''; }
  }
}

function matchList(fromAddr: string, list: Set<string>): boolean {
  const a = fromAddr.toLowerCase().trim();
  if (!a) return false;
  if (list.has(a)) return true;
  const at = a.lastIndexOf('@');
  if (at >= 0 && list.has(a.slice(at))) return true;
  return false;
}

function isBulk(h: Record<string, string>, fromAddr: string): boolean {
  if (h['list-unsubscribe']) return true;
  if (h['precedence'] && /bulk|list|junk/i.test(h['precedence'])) return true;
  if (h['auto-submitted'] && !/^no$/i.test(h['auto-submitted'].trim())) return true;
  const local = (fromAddr.toLowerCase().split('@')[0] || '');
  if (/no[-._]?reply|do[-._]?not[-._]?reply|donotreply/.test(local)) return true;
  if (/^(newsletter|mailer-daemon|bounce|notifications?([-._].*)?|notify|marketing|promo(tions)?|offers?|deals|digest|unsubscribe)$/.test(local)) return true;
  return false;
}

async function loadLists(svc: ReturnType<typeof createClient>, orgId: string): Promise<{ allow: Set<string>; block: Set<string> }> {
  const allow = new Set<string>(); const block = new Set<string>();
  const { data: wl } = await svc.from('mail_allowlist').select('entry, kind').eq('org_id', orgId);
  for (const r of wl ?? []) (r.kind === 'block' ? block : allow).add(String(r.entry).toLowerCase().trim());
  const { data: accs } = await svc.from('accounts').select('email').not('email', 'is', null);
  for (const r of accs ?? []) if (r.email) allow.add(String(r.email).toLowerCase().trim());
  const { data: cts } = await svc.from('contacts').select('email').not('email', 'is', null);
  for (const r of cts ?? []) if (r.email) allow.add(String(r.email).toLowerCase().trim());
  allow.delete(''); block.delete('');
  return { allow, block };
}

function firstMsgId(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/<[^>]+>/);
  return m ? m[0] : null;
}

async function syncAccount(svc: ReturnType<typeof createClient>, acc: Record<string, unknown>, lists: { allow: Set<string>; block: Set<string> }, maxFetch: number): Promise<Record<string, unknown>> {
  const key = String(acc.key);
  const K = key.toUpperCase();
  const host = (acc.imap_host as string) || Deno.env.get(`MAIL_${K}_HOST`);
  const port = Number(acc.imap_port) || 993;
  const user = (acc.email as string) || Deno.env.get(`MAIL_${K}_USER`);
  const pass = Deno.env.get(`MAIL_${K}_PASS`);
  if (!host || !user || !pass) {
    const missing = !pass ? `нет пароля (secret MAIL_${K}_PASS)` : 'нет host/логина в mail_accounts';
    await svc.from('mail_accounts').update({ last_error: missing }).eq('id', acc.id);
    return { key, error: missing };
  }
  const mode = String(acc.filter_mode ?? 'off');
  const imap = new Imap();
  try {
    await imap.connect(host, port);
    await imap.login(user, pass);
    const sel = await imap.cmd('SELECT INBOX');
    if (!sel.ok) throw new Error('SELECT INBOX: ' + sel.status);

    const lastUid = acc.last_uid ? Number(acc.last_uid) : null;
    const sr = await imap.cmd(lastUid ? `UID SEARCH UID ${lastUid + 1}:*` : 'UID SEARCH ALL');
    if (!sr.ok) throw new Error('SEARCH: ' + sr.status);
    let uids: number[] = [];
    for (const ln of sr.lines) { const m = ln.match(/^\* SEARCH\s*(.*)$/i); if (m && m[1]) uids.push(...m[1].trim().split(/\s+/).map(Number).filter((n) => !isNaN(n))); }
    if (lastUid) uids = uids.filter((u) => u > lastUid);
    uids.sort((a, b) => a - b);
    if (uids.length > maxFetch) uids = uids.slice(-maxFetch);

    let maxUid = lastUid ?? 0;
    let skipped = 0;
    const rows: Record<string, unknown>[] = [];
    const attByUid = new Map<number, { filename: string; mime: string; size_bytes: number; is_inline: boolean }[]>();
    const dec = new TextDecoder();

    for (const uid of uids) {
      const fr = await imap.cmd(`UID FETCH ${uid} (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-UNSUBSCRIBE PRECEDENCE AUTO-SUBMITTED CONTENT-TRANSFER-ENCODING)])`);
      if (uid > maxUid) maxUid = uid;
      if (!fr.ok) continue;
      let header = '';
      let bsLine = '';
      for (const ln of fr.lines) {
        const hm = ln.match(/BODY\[HEADER[^\]]*\] <<LIT(\d+)>>/i);
        if (hm) header = dec.decode(fr.literals[parseInt(hm[1], 10)]);
        if (/BODYSTRUCTURE /i.test(ln)) bsLine = ln.replace(/<<LIT(\d+)>>/g, (_m, i) => '"' + dec.decode(fr.literals[parseInt(i, 10)]).replace(/["\\]/g, ' ') + '"');
      }
      if (!header) continue;
      const h = parseHeaders(header);
      const from = parseFrom(h['from'] ?? '');

      let keep = true;
      if (mode === 'allowlist') keep = matchList(from.addr, lists.allow);
      else if (mode === 'smart') {
        if (matchList(from.addr, lists.allow)) keep = true;
        else if (matchList(from.addr, lists.block)) keep = false;
        else keep = !isBulk(h, from.addr);
      }
      if (!keep) { skipped++; continue; }

      const msgId = firstMsgId(h['message-id']);
      const inReplyTo = firstMsgId(h['in-reply-to']);
      const refsRaw = (h['references'] ?? '').match(/<[^>]+>/g) ?? [];
      const threadKey = refsRaw[0] ?? inReplyTo ?? msgId;

      let bodyText = '';
      let bodyHtml: string | null = null;
      const atts: { filename: string; mime: string; size_bytes: number; is_inline: boolean }[] = [];
      let parsedOk = false;
      try {
        const bsIdx = bsLine.search(/BODYSTRUCTURE /i);
        if (bsIdx >= 0) {
          const after = bsLine.slice(bsIdx + 'BODYSTRUCTURE '.length);
          const toks = tokenizeBS(after);
          const tree = parseBS(toks, { i: 0 });
          const parts: MimePart[] = [];
          walkBS(tree, '', parts);
          const plain = parts.find((p) => p.type === 'text' && p.subtype === 'plain' && p.disposition !== 'attachment');
          const html = parts.find((p) => p.type === 'text' && p.subtype === 'html' && p.disposition !== 'attachment');
          for (const p of parts) {
            const isAttach = p.disposition === 'attachment' || (!!p.filename && !(p.type === 'text' && (p.subtype === 'plain' || p.subtype === 'html') && p.disposition !== 'inline'));
            if (isAttach && p.filename) atts.push({ filename: p.filename.slice(0, 300), mime: `${p.type}/${p.subtype}`.slice(0, 100), size_bytes: p.size, is_inline: p.disposition === 'inline' });
            else if (isAttach && p.type === 'image') atts.push({ filename: `image.${p.subtype}`.slice(0, 300), mime: `${p.type}/${p.subtype}`.slice(0, 100), size_bytes: p.size, is_inline: p.disposition === 'inline' });
          }
          if (plain) {
            const pr = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[${plain.path}]<0.16384>)`);
            if (pr.ok && pr.literals.length) bodyText = decodePartBytes(pr.literals[0], plain.encoding, plain.params['charset'] ?? 'utf-8');
          }
          if (html) {
            const hr = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[${html.path}]<0.81920>)`);
            if (hr.ok && hr.literals.length) bodyHtml = decodePartBytes(hr.literals[0], html.encoding, html.params['charset'] ?? 'utf-8').slice(0, 80000);
          }
          if (!bodyText && bodyHtml) bodyText = htmlToText(bodyHtml);
          parsedOk = !!(plain || html);
        }
      } catch (_) { parsedOk = false; }

      if (!parsedOk) {
        const tr = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[TEXT]<0.6144>)`);
        let text = '';
        if (tr.ok) for (const ln of tr.lines) { const tm = ln.match(/BODY\[TEXT\](?:<\d+>)? <<LIT(\d+)>>/i); if (tm) text = dec.decode(tr.literals[parseInt(tm[1], 10)]); }
        bodyText = bodyToText(text, h['content-transfer-encoding']);
      }
      bodyText = rescueBase64(bodyText || '');
      bodyText = bodyText.replace(/\s*\n\s*\n\s*(\n\s*)+/g, '\n\n').trim().slice(0, 4000);

      let sentAt: string | null = null;
      if (h['date']) { const d = new Date(h['date']); if (!isNaN(d.getTime())) sentAt = d.toISOString(); }
      rows.push({
        org_id: acc.org_id, account_id: acc.id, uid,
        message_id: h['message-id'] ?? null,
        in_reply_to: inReplyTo, references_hdr: refsRaw.join(' ').slice(0, 2000) || null, thread_key: threadKey,
        from_name: from.name || null, from_addr: from.addr || null,
        to_addr: h['to'] ? decodeWords(h['to']).slice(0, 500) : null,
        subject: h['subject'] ? decodeWords(h['subject']).slice(0, 500) : '(без темы)',
        snippet: bodyText.slice(0, 400) || null,
        body_text: bodyText || null,
        body_html: bodyHtml,
        has_attachments: atts.length > 0,
        sent_at: sentAt,
      });
      if (atts.length) attByUid.set(uid, atts);
    }

    if (rows.length) {
      const { error } = await svc.from('mail_messages').upsert(rows, { onConflict: 'account_id,uid' });
      if (error) throw new Error('upsert: ' + error.message);
      if (attByUid.size) {
        const uidList = [...attByUid.keys()];
        const { data: msgs } = await svc.from('mail_messages').select('id, uid').eq('account_id', acc.id).in('uid', uidList);
        for (const m of msgs ?? []) {
          const list = attByUid.get(Number(m.uid));
          if (!list) continue;
          await svc.from('mail_attachments').delete().eq('message_id', m.id);
          await svc.from('mail_attachments').insert(list.map((a) => ({ org_id: acc.org_id, message_id: m.id, ...a })));
        }
      }
    }
    await svc.from('mail_accounts').update({ last_sync_at: new Date().toISOString(), last_uid: maxUid || null, last_error: null, active: true }).eq('id', acc.id);
    return { key, mode, fetched: rows.length, skipped_bulk: skipped, with_attachments: attByUid.size };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await svc.from('mail_accounts').update({ last_error: msg.slice(0, 500) }).eq('id', acc.id);
    return { key, error: msg };
  } finally {
    await imap.close();
  }
}

Deno.serve(async (req: Request) => {
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  let allowed = false;
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
        if (prof && ['owner', 'admin'].includes(String(prof.role))) allowed = true;
      }
    }
  }
  if (!allowed) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

  let maxFetch = 30;
  try { const b = await req.json(); if (b && typeof b.max === 'number') maxFetch = Math.min(200, Math.max(1, Math.floor(b.max))); } catch (_) { /* пустое тело */ }

  const { data: accounts, error } = await svc.from('mail_accounts').select('*');
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  const results = [];
  const listCache = new Map<string, { allow: Set<string>; block: Set<string> }>();
  for (const acc of accounts ?? []) {
    const orgId = String(acc.org_id);
    if (!listCache.has(orgId)) listCache.set(orgId, await loadLists(svc, orgId));
    results.push(await syncAccount(svc, acc, listCache.get(orgId)!, maxFetch));
  }
  return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } });
});
