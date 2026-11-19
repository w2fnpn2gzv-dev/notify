// Notify · send-push Edge Function
// 职责：验证调用者是目标用户同房间的成员，然后向其所有已订阅设备发送「有新消息」通知。
// 零知识：通知里不含任何消息内容，只有固定文案。
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") || "mailto:notify-app@users.noreply.supabase.co",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  try {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json(401, { error: "no token" });

    const { data: ud, error: ue } = await admin.auth.getUser(auth.slice(7));
    const caller = ud?.user?.id;
    if (ue || !caller) return json(401, { error: "invalid token" });

    const { uid: target } = await req.json();
    if (!target || typeof target !== "string") return json(400, { error: "no uid" });
    if (target === caller) return json(200, { sent: 0, note: "self" });

    // 调用者与目标必须是同一房间的成员（防滥用）
    const { data: rows } = await admin
      .from("members")
      .select("uid, conv_id")
      .in("uid", [caller, target]);
    const convCaller = rows?.find((r: any) => r.uid === caller)?.conv_id;
    const convTarget = rows?.find((r: any) => r.uid === target)?.conv_id;
    if (!convCaller || convCaller !== convTarget) {
      return json(403, { error: "not in the same conversation" });
    }

    const { data: subs } = await admin
      .from("push_subs")
      .select("sub")
      .eq("uid", target);

    let sent = 0;
    for (const row of subs ?? []) {
      try {
        await webpush.sendNotification(
          row.sub,
          JSON.stringify({ t: "Notify", b: "收到一条新消息", tag: "notify-msg" }),
        );
        sent++;
      } catch (e: any) {
        // 订阅已失效（设备卸载/过期）：清理掉
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await admin.from("push_subs").delete().eq("uid", target);
        }
      }
    }
    return json(200, { sent });
  } catch (e: any) {
    return json(500, { error: String(e?.message || e) });
  }
});
