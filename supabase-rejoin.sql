-- ============================================================
-- Notify v3 迁移：换新手机凭口令重连原房间
-- ------------------------------------------------------------
-- 背景：B 方换新手机后，本机身份密钥丢失，旧房间（pub_b 已占用）
--       无法用原口令加入。本次让 join_conv 增加一条「重连」路径：
--       口令匹配 + 房间创建 3 天内 + 调用者不是房间成员 时，
--       原子替换 B 位公钥并接管成员身份；旧设备密钥与订阅随即失效。
-- 安全边界：
--   * 零知识不变：服务器只见 (salt, code_hash, 新公钥)，不见口令
--   * 盐对「已满房间」的暴露窗口从无 → 3 天，限制离线穷举面
--   * 重连复用 join_try 限流（IP + 设备双维度，10 次/15 分钟）
--   * RLS 保证被顶掉的旧设备立即失去一切读取权限
--   * 换机前的历史消息用旧密钥加密，新设备解不开 → 客户端显示
--     「🔒 换机前的加密消息」占位（密文阅后即焚，通常早已被服务端清掉）
-- ============================================================

-- 0. 防并发重连：同一房间的 b 位成员只允许一行（并发重连时后到者报 duplicate key）
create unique index if not exists members_conv_role_uniq on public.members(conv_id, role);

-- 1. join_conv：常规加入 + 重连两条路径
drop function if exists public.join_conv(text, jsonb);
create or replace function public.join_conv(p_code_hash text, p_pub jsonb)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
  v_target uuid;
  v_pub jsonb;
  v_ip text;
  v_tries int;
  v_old_b uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  -- 已是某房间成员：自己那间还没人加入就作废它，否则拒绝
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

  -- 路径 1：常规加入（房间空着、口令 30 分钟内有效）
  select c.id into v_target
    from public.conv c
   where c.code_hash = p_code_hash
     and c.pub_b is null
     and c.created_at > now() - interval '30 minutes'
   order by c.created_at
   limit 1;

  if v_target is not null then
    -- 原子抢占：两个设备同时用同一口令时，只有一个能把 pub_b 从 null 改掉，
    -- 另一个影响 0 行直接失败，否则会变成三个人一间房
    update public.conv set pub_b = p_pub
     where id = v_target and pub_b is null
    returning id into v_id;
    if v_id is null then return null; end if;

    insert into public.members(conv_id, uid, role, pub) values (v_id, auth.uid(), 'b', p_pub);
    return v_id;
  end if;

  -- 路径 2：重连（换新手机）。房间已满但口令匹配、房间创建 3 天内；
  -- 能走到这里的调用者必然不是任何房间成员（上面已拦），A 方成员
  -- 想借口令顶掉 B 也不可能——他自己在成员表里，第一段就被拦下。
  select c.id into v_target
    from public.conv c
   where c.code_hash = p_code_hash
     and c.pub_b is not null
     and c.created_at > now() - interval '3 days'
     and not exists (select 1 from public.members m where m.conv_id = c.id and m.uid = auth.uid())
   order by c.created_at desc
   limit 1;
  if v_target is null then return null; end if;

  -- 记下旧 B 设备身份，替换后把它的订阅一并作废
  select uid into v_old_b from public.members
   where conv_id = v_target and role = 'b' limit 1;

  update public.conv set pub_b = p_pub
   where id = v_target
  returning id into v_id;
  if v_id is null then return null; end if;

  delete from public.members where conv_id = v_target and role = 'b';
  delete from public.push_subs where uid = v_old_b;
  insert into public.members(conv_id, uid, role, pub) values (v_id, auth.uid(), 'b', p_pub);
  return v_id;
end $$;

-- 2. pairing_salt：开放房间 30 分钟内、已满房间 3 天内都返回盐（重连要用）
create or replace function public.pairing_salt()
returns text language sql stable security definer as $$
  select salt from public.conv
   where (pub_b is null and created_at > now() - interval '30 minutes')
      or (pub_b is not null and created_at > now() - interval '3 days')
   order by created_at desc limit 1
$$;

-- 3. 权限（函数签名不变，重复授予无副作用）
grant execute on function public.join_conv(text, jsonb) to authenticated, anon;
grant execute on function public.pairing_salt()        to authenticated, anon;
