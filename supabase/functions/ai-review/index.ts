// AI-REVIEW v2 (24.07, Бета-8) — бренд-строка Marvel (хвост 5): без «босс» (закон ребрендинга v21),
// представляется Marvel. Логика не тронута. Откат: v1.
// AI-REVIEW v1 (19.07, Бета-6) — проактивный утренний ревизор (закон Андрея: «заранее говори о проблемах»).
// Ежедневный обход данных → короткий доклад-сообщение ОБОИМ владельцам (Andrew + Serge, не QA).
// Авторизация: x-review-token == app_settings.settings.review_token (паттерн evening-digest). Cron ~6:30 LA.
// Отчёт собирается ДЕТЕРМИНИСТИЧНО (надёжно, без внешних зависимостей); форма — живая речь без разметки.
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const token = req.headers.get('x-review-token');
  const { data: st } = await svc.from('app_settings').select('org_id, timezone, settings').limit(1).maybeSingle();
  if (!token || !st?.settings?.review_token || st.settings.review_token !== token) return json({ error: 'forbidden' }, 403);
  const tz = (st?.timezone as string) || 'America/Los_Angeles';

  const now = new Date();
  const today = localDate(now, tz);
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString();
  const since24 = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  // по всем организациям (у нас одна, но честно по org)
  const { data: orgs } = await svc.from('organizations').select('id');
  let totalSent = 0;
  const perOrg: unknown[] = [];

  for (const org of orgs ?? []) {
    const orgId = String(org.id);
    const [tasksQ, projQ, asgQ, evQ, filesQ, mailQ, ownersQ] = await Promise.all([
      svc.from('tasks').select('title, due_date, project_id').eq('org_id', orgId).is('deleted_at', null).neq('status', 'done').not('due_date', 'is', null).lte('due_date', today).limit(200),
      svc.from('projects').select('id, name').eq('org_id', orgId).eq('status', 'active').is('deleted_at', null).limit(100),
      svc.from('project_assignments').select('project_id').eq('org_id', orgId).limit(500),
      svc.from('events').select('event_type, data, created_at').eq('org_id', orgId).in('event_type', ['shift.silent', 'travel.long', 'shift.overlong_ping']).gte('created_at', since24).limit(200),
      svc.from('files').select('name, expires_at, profile_id, scope').eq('org_id', orgId).not('expires_at', 'is', null).gte('expires_at', now.toISOString()).lte('expires_at', in30).is('deleted_at', null).limit(100),
      svc.from('mail_messages').select('subject, from_name, sent_at').eq('org_id', orgId).gte('sent_at', since24).limit(100),
      svc.from('profiles').select('id, name').eq('org_id', orgId).eq('role', 'owner').eq('is_active', true).is('deleted_at', null).limit(10),
    ]);

    const overdue = tasksQ.data ?? [];
    const projects = projQ.data ?? [];
    const assignedProjectIds = new Set((asgQ.data ?? []).map((a) => String(a.project_id)));
    const emptyProjects = projects.filter((p) => !assignedProjectIds.has(String(p.id)));
    const silent = (evQ.data ?? []).filter((e) => e.event_type === 'shift.silent').length;
    const travels = (evQ.data ?? []).filter((e) => e.event_type === 'travel.long');
    const forgot = (evQ.data ?? []).filter((e) => e.event_type === 'shift.overlong_ping').length;
    const expiring = filesQ.data ?? [];
    const mail = (mailQ.data ?? []).length;

    const lines: string[] = ['Доброе утро. Marvel на связи, сводка на ' + today + '.'];
    let anything = false;

    if (overdue.length) {
      anything = true;
      const pn = new Map(projects.map((p) => [String(p.id), String(p.name)]));
      const top = overdue.slice(0, 3).map((t) => t.title + (t.project_id ? ' (' + (pn.get(String(t.project_id)) ?? '—') + ')' : '')).join(', ');
      lines.push('Просроченных задач: ' + overdue.length + '. Среди них ' + top + '.');
    }
    if (emptyProjects.length) {
      anything = true;
      lines.push('Активных проектов без назначенных людей: ' + emptyProjects.length + ' (' + emptyProjects.slice(0, 3).map((p) => p.name).join(', ') + ').');
    }
    if (silent || travels.length || forgot) {
      anything = true;
      const bits: string[] = [];
      if (silent) bits.push('тишина GPS ' + silent);
      if (travels.length) bits.push('долгие проезды ' + travels.length);
      if (forgot) bits.push('забытые смены ' + forgot);
      lines.push('За сутки по сменам: ' + bits.join(', ') + '.');
      if (travels.length) {
        const t0 = travels[0].data as Record<string, unknown>;
        if (t0?.name) lines.push('Например, проезд у ' + t0.name + ' на ' + (t0.minutes ?? '?') + ' минут (' + (t0.from ?? '—') + ' → ' + (t0.to ?? '—') + ').');
      }
    }
    if (expiring.length) {
      anything = true;
      lines.push('Скоро истекают документы: ' + expiring.length + ' (ближайшие 30 дней) — проверь страховки и лицензии.');
    }
    if (mail) lines.push('Новых писем за сутки: ' + mail + '.');

    if (!anything && !mail) lines.push('Всё спокойно, хвостов нет.');
    const bodyText = lines.join(' ');

    let sent = 0;
    for (const owner of ownersQ.data ?? []) {
      if (String(owner.name).toUpperCase().startsWith('QA')) continue;
      const { error } = await svc.from('messages').insert({
        org_id: orgId, sender_id: owner.id, recipient_id: owner.id,
        priority: 'info', body: bodyText, metadata: { system: true, kind: 'ai_review', date: today },
      });
      if (!error) sent++;
    }
    await svc.from('events').insert({
      org_id: orgId, event_type: 'ai.review', entity_type: 'organization', entity_id: orgId, actor_name: 'Marvel',
      data: { date: today, overdue: overdue.length, empty_projects: emptyProjects.length, silent, travels: travels.length, forgot, expiring: expiring.length, mail, sent },
    });
    totalSent += sent;
    perOrg.push({ org: orgId, sent, overdue: overdue.length, empty_projects: emptyProjects.length, shift_flags: silent + travels.length + forgot, expiring: expiring.length });
  }

  return json({ ok: true, sent: totalSent, orgs: perOrg });
});
