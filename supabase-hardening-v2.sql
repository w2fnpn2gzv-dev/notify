-- ============================================================
--  Notify · 服务端加固 v2
--  目标：① 一台设备只能有一个房间 ② 撤回即擦除密文 ③ 定时清理不留痕迹
--  可重复执行（幂等）
-- ============================================================

-- ---------- 0. 一次性修正：同一设备只允许存在于一个房间 ----------
-- 若历史数据里已有重复成员，先只保留最新一条，避免建唯一索引失败
delete from public.members m
 where m.ctid <> (
   select max(m2.ctid) from public.members m2 where m2.uid = m.uid
 );
create unique index if not exists members_uid_uniq on public.members(uid);

-- ---------- 1. 建房：已有房间则报错（不再产生孤儿房） ----------
-- v6: 每房间独立随机盐（防离线穷举）
alter table public.conv add column if not exists salt text;
create or replace function public.create_conv(p_code_hash text, p_salt text, p_pub jsonb)
returns uuid language plpgsql security definer as $$
declare v_id uuid; v_pub jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  select m.conv_id, c.pub_b into v_id, v_pub
    from public.members m join public.conv c on c.id = m.conv_id
   where m.uid = auth.uid() limit 1;

  if v_id is not null then
    if v_pub is null then
      -- 旧房间还没人加入（比如口令过期了）：直接作废重建，避免卡死
      delete from public.conv where id = v_id;
    else
      raise exception '这台设备已经在一个房间里了';
    end if;
  end if;

  insert into public.conv(code_hash, salt, pub_a) values (p_code_hash, p_salt, p_pub) returning id into v_id;
  insert into public.members(conv_id, uid, role, pub) values (v_id, auth.uid(), 'a', p_pub);
  return v_id;
exception
  when unique_violation then
    raise exception '操作正在进行，请稍后重试';
end $$;

-- ---------- 2. 加入：已有房间则拒绝 + IP/设备 双维度限流 + 口令 30 分钟有效 ----------
create table if not exists public.join_try(
  id bigserial primary key,
  ip text,
  uid uuid,
  at timestamptz not null default now()
);
alter table public.join_try add column if not exists uid uuid;
alter table public.join_try enable row level security;   -- 无策略：只有 definer 函数可读写
create index if not exists join_try_ip_at  on public.join_try(ip, at);
create index if not exists join_try_uid_at on public.join_try(uid, at);

create or replace function public.join_conv(p_code_hash text, p_pub jsonb)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
  v_target uuid;
  v_pub jsonb;
  v_ip text;
  v_tries int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  select m.conv_id, c.pub_b into v_id, v_pub
    from public.members m join public.conv c on c.id = m.conv_id
   where m.uid = auth.uid() limit 1;
  if v_id is not null then
    if v_pub is null then
      delete from public.conv where id = v_id;   -- 自己那间还没人加入，先作废
      v_id := null;
    else
      raise exception '这台设备已经在一个房间里了';
    end if;
  end if;

  v_ip := coalesce(nullif((current_setting('request.headers', true)::jsonb)->>'x-forwarded-for', ''), 'unknown');
  -- 网关出口 IP 会轮换，所以同时按「设备身份」计数；任一维度超限即拦
  select count(*) into v_tries from public.join_try
   where (ip = v_ip or uid = auth.uid()) and at > now() - interval '15 minutes';
  if v_tries >= 10 then
    raise exception '尝试次数过多，请 15 分钟后再试';
  end if;

  -- 先记账再校验口令：口令错误时用 return null 而不是 raise，
  -- 否则整个事务回滚，尝试记录会一起消失，限流就形同虚设
  insert into public.join_try(ip, uid) values (v_ip, auth.uid());
  delete from public.join_try where at < now() - interval '1 day';

  select c.id into v_target
    from public.conv c
   where c.code_hash = p_code_hash
     and c.pub_b is null
     and c.created_at > now() - interval '30 minutes'   -- 口令 30 分钟内有效
   order by c.created_at
   limit 1;
  if v_target is null then return null; end if;

  -- 原子抢占：两个设备同时用同一口令时，只有一个能把 pub_b 从 null 改掉，
  -- 另一个影响 0 行直接失败，否则会变成三个人一间房
  update public.conv set pub_b = p_pub
   where id = v_target and pub_b is null
  returning id into v_id;
  if v_id is null then return null; end if;

  insert into public.members(conv_id, uid, role, pub) values (v_id, auth.uid(), 'b', p_pub);
  return v_id;
end $$;

-- ---------- 3. 退出房间（清除本地数据时调用，避免留下孤儿房间） ----------
create or replace function public.leave_conv()
returns void language plpgsql security definer as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select conv_id into v_id from public.members where uid = auth.uid() limit 1;
  if v_id is null then return; end if;
  delete from public.members where conv_id = v_id and uid = auth.uid();
  -- 房间里没人了 → 整间连带消息一起删掉
  if not exists (select 1 from public.members where conv_id = v_id) then
    delete from public.conv where id = v_id;   -- msgs 通过外键级联删除
  end if;
end $$;

-- ---------- 4. 撤回：直接把密文抹成空，服务器不再留任何可解密内容 ----------
create or replace function public.recall_message(p_id uuid)
returns void language plpgsql security definer as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update public.msgs
     set recalled = true,
         payload  = '{}'::jsonb,
         read_at  = coalesce(read_at, now())
   where id = p_id
     and sender = auth.uid()
     and conv_id in (select conv_id from public.members where uid = auth.uid());
  if not found then raise exception '撤回失败'; end if;
end $$;

-- ---------- 5. 已读回执：由服务器盖章，客户端不能改别人的消息 ----------
create or replace function public.mark_read(p_id uuid)
returns void language plpgsql security definer as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update public.msgs
     set read_at    = coalesce(read_at, now()),
         expires_at = coalesce(expires_at, now() + interval '15 minutes')
   where id = p_id
     and sender <> auth.uid()
     and conv_id in (select conv_id from public.members where uid = auth.uid());
end $$;

-- 收回客户端的直接改/删权限，避免对方篡改或抹掉你的密文
drop policy if exists msgs_update on public.msgs;
drop policy if exists msgs_delete on public.msgs;

-- ---------- 6. 清理策略：过期即删 + 撤回墓碑 1 小时 + 未读 7 天兜底 ----------
create or replace function public.purge_expired()
returns void language sql security definer as $$
  delete from public.msgs where expires_at is not null and expires_at < now();
  delete from public.msgs where recalled and created_at < now() - interval '1 hour';
  delete from public.msgs where read_at is null and created_at < now() - interval '7 days';
  -- 口令 30 分钟没人使用的空房间一并清掉（members 随外键级联删除）
  delete from public.conv c where c.pub_b is null and c.created_at < now() - interval '30 minutes';
$$;

-- ---------- 6.5 服务器时间（手机时间不准时用来校正倒计时） ----------
create or replace function public.server_now()
returns timestamptz language sql stable as $$ select now() $$;

-- ---------- 6.6 取当前开放房间的盐（盐不是秘密；用于客户端本地计算口令哈希） ----------
create or replace function public.pairing_salt()
returns text language sql stable security definer as $$
  select salt from public.conv
   where pub_b is null and created_at > now() - interval '30 minutes'
   order by created_at desc limit 1
$$;

-- ---------- 7. 权限 ----------
grant execute on function public.create_conv(text, jsonb) to authenticated, anon;
grant execute on function public.join_conv(text, jsonb)   to authenticated, anon;
grant execute on function public.leave_conv()             to authenticated, anon;
grant execute on function public.recall_message(uuid)     to authenticated, anon;
grant execute on function public.mark_read(uuid)          to authenticated, anon;
grant execute on function public.purge_expired()          to authenticated, anon;
grant execute on function public.server_now()             to authenticated, anon;
grant execute on function public.pairing_salt()            to authenticated, anon;

-- ---------- 8. 每分钟自动清理（需要 pg_cron；没有就跳过，不影响使用） ----------
do $ext$
begin
  create extension if not exists pg_cron;
exception when others then null;
end $ext$;

do $unsched$
begin
  perform cron.unschedule('notify-purge');
exception when others then null;
end $unsched$;

do $sched$
begin
  perform cron.schedule('notify-purge', '* * * * *', $job$select public.purge_expired()$job$);
exception when others then null;
end $sched$;


-- ---------- 9. Web Push 订阅（v6 新增） ----------
create table if not exists public.push_subs(
  uid uuid primary key,                       -- 一台设备一个订阅，重复订阅覆盖
  sub jsonb not null,
  at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "push_subs self" on public.push_subs;
create policy "push_subs self" on public.push_subs
  for all to authenticated using (uid = auth.uid()) with check (uid = auth.uid());
