-- ============================================================
--  Notify · Supabase 数据库初始化
--  用法：Supabase 控制台 → 左侧 SQL Editor → 新建查询 → 粘贴全部 → Run
--  可重复执行（幂等）
-- ============================================================

-- 1. 会话表：一条记录 = 你们俩的一间聊天室
create table if not exists public.conv (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null,                 -- 6 位口令的 PBKDF2 哈希（服务器也看不到口令原文）
  pub_a      jsonb not null,                -- 创建方(A)的 ECDH 公钥
  pub_b      jsonb,                         -- 加入方(B)的公钥
  created_at timestamptz not null default now()
);

-- 2. 成员表
create table if not exists public.members (
  conv_id    uuid not null references public.conv(id) on delete cascade,
  uid        uuid not null,
  role       text not null check (role in ('a','b')),
  pub        jsonb,
  created_at timestamptz not null default now(),
  primary key (conv_id, uid)
);

-- 3. 消息表（payload 永远是密文）
create table if not exists public.msgs (
  id         uuid primary key default gen_random_uuid(),
  conv_id    uuid not null references public.conv(id) on delete cascade,
  sender     uuid not null,
  kind       text not null default 'text',  -- text | image | voice | video
  payload    jsonb not null,                -- {iv, data} 密文，服务器无法解
  created_at timestamptz not null default now(),
  read_at    timestamptz,                   -- 读过的时刻（自毁倒计时起点）
  expires_at timestamptz,                   -- 销毁时刻 = read_at + 15 分钟
  recalled   boolean not null default false
);
create index if not exists msgs_conv_idx on public.msgs(conv_id, created_at);

-- 4. 行级权限
alter table public.conv    enable row level security;
alter table public.members enable row level security;
alter table public.msgs    enable row level security;

-- 我参与的所有会话
create or replace function public.my_conv_ids() returns setof uuid
language sql security definer stable as $$
  select conv_id from public.members where uid = auth.uid()
$$;

drop policy if exists conv_select on public.conv;
create policy conv_select on public.conv for select
  using (id in (select public.my_conv_ids()));

drop policy if exists members_select on public.members;
create policy members_select on public.members for select
  using (conv_id in (select public.my_conv_ids()));

drop policy if exists msgs_select on public.msgs;
create policy msgs_select on public.msgs for select
  using (conv_id in (select public.my_conv_ids()));

drop policy if exists msgs_insert on public.msgs;
create policy msgs_insert on public.msgs for insert
  with check (conv_id in (select public.my_conv_ids()) and sender = auth.uid());

drop policy if exists msgs_update on public.msgs;
create policy msgs_update on public.msgs for update
  using (conv_id in (select public.my_conv_ids()));

drop policy if exists msgs_delete on public.msgs;
create policy msgs_delete on public.msgs for delete
  using (conv_id in (select public.my_conv_ids()));

-- 5. 建会话（A 方：设置 6 位口令）
create or replace function public.create_conv(p_code_hash text, p_pub jsonb)
returns uuid language plpgsql security definer as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.conv(code_hash, pub_a) values (p_code_hash, p_pub) returning id into v_id;
  insert into public.members(conv_id, uid, role, pub) values (v_id, auth.uid(), 'a', p_pub);
  return v_id;
end $$;

-- 6. 加入会话（B 方：输入同一口令）
create or replace function public.join_conv(p_code_hash text, p_pub jsonb)
returns uuid language plpgsql security definer as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select c.id into v_id
    from public.conv c
   where c.code_hash = p_code_hash
     and c.pub_b is null
     and not exists (select 1 from public.members m where m.conv_id = c.id and m.uid = auth.uid())
   order by c.created_at
   limit 1;
  if v_id is null then raise exception '口令无效或已被使用'; end if;
  update public.conv set pub_b = p_pub where id = v_id;
  insert into public.members(conv_id, uid, role, pub) values (v_id, auth.uid(), 'b', p_pub);
  return v_id;
end $$;

-- 7. 清理已过期消息（客户端每次拉取时调用）
create or replace function public.purge_expired()
returns void language sql security definer as $$
  delete from public.msgs
   where expires_at is not null and expires_at < now();
$$;

grant execute on function public.create_conv(text, jsonb) to authenticated, anon;
grant execute on function public.join_conv(text, jsonb)  to authenticated, anon;
grant execute on function public.purge_expired()          to authenticated, anon;

-- 8. 开启定时清理（可选：需要 pg_cron 扩展，失败不影响使用）
-- select cron.schedule('notify-purge', '*/5 * * * *', $$select public.purge_expired()$$);
