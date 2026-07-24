import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// evening-digest (DIGEST-1): вечерний пуш «что завтра» владельцу/админам/менеджерам.
// Вызывается pg_cron ЕЖЕЧАСНО (0035) с заголовком x-digest-token; шлёт только если
// org-local час == app_settings.digest_hour (или body.force=true для теста).
// verify_jwt=false — аутентификация СОБСТВЕННАЯ: токен из app_settings.settings.digest_token.

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function orgLocal(now: Date, tz: string): { hour: number; tomorrow: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = parseInt(parts.hour === "24" ? "0" : parts.hour, 10);
  const localMidnight = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`); // полдень, без DST-краёв
  const t = new Date(localMidnight.getTime() + 24 * 3600 * 1000);
  const tomorrow = t.toISOString().slice(0, 10);
  return { hour, tomorrow };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const token = req.headers.get("x-digest-token") ?? "";
  const body = await req.json().catch(() => ({}));
  const force = body?.force === true;

  const { data: settingsRows } = await admin.from("app_settings")
    .select("org_id, timezone, digest_hour, default_language, settings");
  if (!settingsRows || settingsRows.length === 0) return json({ ok: true, sent: 0, reason: "no_orgs" });

  let totalSent = 0;
  const results: any[] = [];

  for (const s of settingsRows) {
    const expected = (s.settings as any)?.digest_token;
    if (!expected || token !== expected) { results.push({ org: s.org_id, skip: "bad_token" }); continue; }

    const tz = s.timezone || "America/Los_Angeles";
    const { hour, tomorrow } = orgLocal(new Date(), tz);
    if (!force && hour !== (s.digest_hour ?? 18)) { results.push({ org: s.org_id, skip: `hour ${hour}!=${s.digest_hour}` }); continue; }

    // Собираем «завтра»
    const dayStart = `${tomorrow}T00:00:00`;
    const dayEnd = `${tomorrow}T23:59:59`;
    const [evRes, startRes, deadlineRes, taskRes] = await Promise.all([
      admin.from("calendar_events").select("title, starts_at, event_type").eq("org_id", s.org_id)
        .gte("starts_at", dayStart).lte("starts_at", dayEnd).is("deleted_at", null).limit(20),
      admin.from("projects").select("name").eq("org_id", s.org_id).eq("start_date", tomorrow).is("deleted_at", null),
      admin.from("projects").select("name").eq("org_id", s.org_id).eq("end_date", tomorrow).is("deleted_at", null),
      admin.from("tasks").select("title").eq("org_id", s.org_id).eq("due_date", tomorrow).is("deleted_at", null)
        .not("status", "in", "(done,cancelled)").limit(20),
    ]);
    const events = evRes.data ?? [];
    const starts = startRes.data ?? [];
    const deadlines = deadlineRes.data ?? [];
    const dueTasks = taskRes.data ?? [];
    const count = events.length + starts.length + deadlines.length + dueTasks.length;
    if (count === 0) { results.push({ org: s.org_id, skip: "nothing_tomorrow" }); continue; }

    const lines: string[] = [];
    for (const p of starts) lines.push(`▶ Старт: ${p.name}`);
    for (const p of deadlines) lines.push(`⏰ Дедлайн: ${p.name}`);
    for (const e of events) lines.push(`• ${(e.starts_at ?? "").slice(11, 16)} ${e.title}`);
    for (const t of dueTasks) lines.push(`☐ Срок задачи: ${t.title}`);
    const bodyText = lines.slice(0, 6).join("\n") + (lines.length > 6 ? `\n…и ещё ${lines.length - 6}` : "");
    const title = `Завтра: ${count} событий`;

    // Получатели: owner/admin/manager с активными подписками
    const { data: managers } = await admin.from("profiles").select("id")
      .eq("org_id", s.org_id).in("role", ["owner", "admin", "manager"]).eq("is_active", true).is("deleted_at", null);
    const ids = (managers ?? []).map((m: any) => m.id);
    if (ids.length === 0) { results.push({ org: s.org_id, skip: "no_managers" }); continue; }
    const { data: subs } = await admin.from("push_subscriptions")
      .select("id, endpoint, p256dh, auth").in("profile_id", ids).is("revoked_at", null);
    if (!subs || subs.length === 0) { results.push({ org: s.org_id, skip: "no_subscriptions" }); continue; }

    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT") ?? "mailto:nwbuildpro@gmail.com",
      Deno.env.get("VAPID_PUBLIC_KEY")!,
      Deno.env.get("VAPID_PRIVATE_KEY")!,
    );
    const payload = JSON.stringify({ title, body: bodyText, url: "/team-calendar" });
    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (e: any) {
        const code = e?.statusCode ?? 0;
        if (code === 404 || code === 410) {
          await admin.from("push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("id", sub.id);
        }
      }
    }
    totalSent += sent;
    results.push({ org: s.org_id, tomorrow, count, sent });
    try {
      await admin.from("events").insert({
        org_id: s.org_id, event_type: "digest.sent", entity_type: "org", entity_id: s.org_id,
        actor_name: "system", data: { tomorrow, count, sent, lines: lines.slice(0, 10) },
      });
    } catch (_e) { /* best-effort */ }
  }

  return json({ ok: true, sent: totalSent, results });
});
