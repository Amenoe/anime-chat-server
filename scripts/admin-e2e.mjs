/**
 * 管理端（用户管理 + 封禁 + 审计 + 级联删号）端到端验收脚本（**真实打接口**）
 *
 * 用法：先启动后端，再执行
 *   node scripts/admin-e2e.mjs
 *   BASE=http://127.0.0.1:3000/api node scripts/admin-e2e.mjs
 *
 * ⚠️ 与 `auth-e2e.mjs` 不同，本脚本**需要直连数据库**，原因有两个：
 *   1. 「授予 root」没有任何接口（这是有意的，避免提权面），只能改库；
 *   2. 「删号不留孤儿」必须直接查表才能证明 —— 只调接口看不出孤儿数据。
 *   数据库连接从 `.env.development` 读取（与后端同一份配置）。
 *
 * 覆盖：非 root 越权 → 列表（无密码字段 / LIKE 转义）→ 封禁即时生效三处拦截 →
 *       解封 → 改角色 → 自锁防护 → 重置密码与会话吊销 → 提权红线 →
 *       级联删号无孤儿 → 审计留痕且不含密码明文
 *
 * 测试账号与测试数据会在结束时清理。退出码非 0 表示有用例失败。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:3000/api';
const TAG = Date.now().toString().slice(-6);
const ADMIN_USER = `ae2e${TAG}`;
const VICTIM_USER = `ve2e${TAG}`;
const PASSWORD = 'test1234';
const NEW_PASSWORD = 'reset1234';

let pass = 0;
let fail = 0;

/*
 * 已创建的测试账号 id，**模块级**保存。
 * 原因：脚本若中途抛异常（历史上就有一次 —— `ai_usage` 主键类型写错，
 * 崩在清理之前），`main().catch()` 的兜底清理必须还能收拾现场。
 * 只按用户名删是不够的：那时用户行可能已经不存在，而它名下的埋点行还留着，
 * 会永久污染开发库（表现为孤儿埋点行）。
 */
let adminIdForCleanup = '';
let victimIdForCleanup = '';

function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 空响应 */
  }
  return { status: res.status, json, data: json?.data };
}

// ── 数据库直连（只为「授予 root」与「查孤儿」，见文件头说明）──────
function loadDbConfig() {
  const text = readFileSync(join(HERE, '..', '.env.development'), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const DB = loadDbConfig();

function sql(query) {
  const args = [
    '-N',
    '-B',
    '-h',
    DB.DB_HOST || 'localhost',
    '-P',
    DB.DB_PORT || '3306',
    '-u',
    DB.DB_USERNAME || 'root',
    `-p${DB.DB_PASSWORD}`,
    DB.DB_DATABASE || 'anime_chat',
    '-e',
    query,
  ];
  return execFileSync('mysql', args, { encoding: 'utf8' }).trim();
}

const main = async () => {
  console.log(`\n== 目标 ${BASE} · 测试账号 ${ADMIN_USER} / ${VICTIM_USER} ==`);

  /*
   * 孤儿行基线。
   *
   * ⚠️ 不能断言「全局零孤儿」—— 这是**共享的开发库**，别人（其它脚本、并行 agent）
   * 跑完留下的孤儿行会让本脚本无辜失败。实测遇到过：前端验证脚本删账号时
   * 留下 page.view 孤儿（因为 `track_event` 是有意保留的），本脚本就报了失败。
   * 所以只断言「**本次运行没有新增**孤儿」，那才是本脚本该负责的不变量。
   */
  const orphansBefore = Number(
    sql(
      'SELECT COUNT(*) FROM track_event WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT user_id FROM `user`)',
    ),
  );

  // ── 建号 + 提权 ────────────────────────────────────────────
  for (const [u, nick] of [
    [ADMIN_USER, '管理e2e'],
    [VICTIM_USER, '受害者'],
  ]) {
    const r = await call('POST', '/user/register', {
      body: { username: u, password: PASSWORD, nickname: nick },
    });
    check(
      `注册 ${u}`,
      r.status === 200 || r.status === 201,
      JSON.stringify(r.json),
    );
  }
  sql(`UPDATE \`user\` SET role='root' WHERE username='${ADMIN_USER}'`);

  const adminLogin = await call('POST', '/auth/login', {
    body: { username: ADMIN_USER, password: PASSWORD },
  });
  const adminTok = adminLogin.data?.accessToken;
  check('管理员登录', !!adminTok);

  const victimLogin = await call('POST', '/auth/login', {
    body: { username: VICTIM_USER, password: PASSWORD },
  });
  const victimTok = victimLogin.data?.accessToken;
  const victimId = victimLogin.data?.user?.user_id;
  const victimRefresh = victimLogin.data?.refreshToken;
  check('普通用户登录', !!victimTok && !!victimId);
  const adminId = adminLogin.data?.user?.user_id;
  adminIdForCleanup = adminId ?? '';
  victimIdForCleanup = victimId ?? '';

  // ── 1. 越权：非 root 打管理端 ──────────────────────────────
  console.log('\n-- 1. 越权防护 --');
  const forbidden = [
    ['GET', '/admin/users'],
    ['GET', `/admin/users/${victimId}`],
    ['GET', '/admin/users/audit'],
    ['PATCH', `/admin/users/${victimId}/ban`],
    ['PATCH', `/admin/users/${victimId}/role`],
    ['POST', `/admin/users/${victimId}/password`],
    ['DELETE', `/admin/users/${victimId}`],
  ];
  for (const [m, p] of forbidden) {
    const r = await call(m, p, {
      token: victimTok,
      body: m === 'GET' || m === 'DELETE' ? undefined : { banned: true },
    });
    check(`非 root ${m} ${p} → 403`, r.status === 403, `实际 ${r.status}`);
  }
  const anon = await call('GET', '/admin/users');
  check(
    '匿名访问 /admin/users → 401',
    anon.status === 401,
    `实际 ${anon.status}`,
  );

  // ── 2. 列表 ───────────────────────────────────────────────
  console.log('\n-- 2. 列表与字段白名单 --');
  const list = await call('GET', '/admin/users?size=5', { token: adminTok });
  check('root 可列表', list.status === 200 && Array.isArray(list.data?.items));
  check('响应含 total/page/size', typeof list.data?.total === 'number');
  const raw = JSON.stringify(list.json);
  check(
    '响应**不含** password 字段',
    !raw.includes('"password"'),
    raw.slice(0, 120),
  );

  const kw = await call(
    'GET',
    `/admin/users?keyword=${encodeURIComponent(ADMIN_USER)}`,
    { token: adminTok },
  );
  check(
    '关键词能命中自己',
    kw.data?.items?.some((u) => u.username === ADMIN_USER),
  );

  /*
   * LIKE 转义：不转义时 `%` 等于「匹配全部」，会返回全表。
   * 用一个绝不可能存在的关键词验证 —— 期望 total 为 0。
   */
  const pct = await call('GET', '/admin/users?keyword=%25%25%25', {
    token: adminTok,
  });
  check(
    'LIKE 通配符已转义（`%%%` 不返回全表）',
    pct.data?.total === 0,
    `实际 total=${pct.data?.total}`,
  );

  // 分页：size=1 时两页应给出不同的人
  const p1 = await call('GET', '/admin/users?page=1&size=1', {
    token: adminTok,
  });
  const p2 = await call('GET', '/admin/users?page=2&size=1', {
    token: adminTok,
  });
  check(
    '分页生效（page=1 与 page=2 返回不同用户）',
    p1.data?.items?.length === 1 &&
      p2.data?.items?.length === 1 &&
      p1.data.items[0].user_id !== p2.data.items[0].user_id,
    `p1=${p1.data?.items?.[0]?.username} p2=${p2.data?.items?.[0]?.username}`,
  );
  check('分页返回一致的 total', p1.data?.total === p2.data?.total);

  // role 过滤
  const onlyUser = await call('GET', '/admin/users?role=user&size=100', {
    token: adminTok,
  });
  check(
    'role=user 只返回普通用户',
    onlyUser.data?.items?.length > 0 &&
      onlyUser.data.items.every((u) => u.role === 'user'),
  );
  const onlyRoot = await call('GET', '/admin/users?role=root&size=100', {
    token: adminTok,
  });
  check(
    'role=root 只返回管理员',
    onlyRoot.data?.items?.length > 0 &&
      onlyRoot.data.items.every((u) => u.role === 'root'),
  );

  // 详情 + 数据规模
  const detail = await call('GET', `/admin/users/${victimId}`, {
    token: adminTok,
  });
  check(
    '详情返回 user 与 stats',
    detail.data?.user?.user_id === victimId &&
      typeof detail.data?.stats?.conversations === 'number',
    JSON.stringify(detail.json).slice(0, 160),
  );
  check(
    '详情同样不含 password 字段',
    !JSON.stringify(detail.json).includes('"password"'),
  );

  // ── 3. 封禁即时生效（三处拦截）──────────────────────────────
  console.log('\n-- 3. 封禁 --');
  const ban = await call('PATCH', `/admin/users/${victimId}/ban`, {
    token: adminTok,
    body: { banned: true, reason: 'e2e 测试封禁' },
  });
  check('封禁成功', ban.status === 200, JSON.stringify(ban.json));
  check(
    '封禁后 disabled_at 非空',
    !!ban.data?.user?.disabled_at,
    JSON.stringify(ban.data?.user),
  );

  // disabled 过滤（必须在封禁之后测，否则过滤不出区别）
  const onlyDisabled = await call(
    'GET',
    '/admin/users?disabled=true&size=100',
    {
      token: adminTok,
    },
  );
  check(
    'disabled=true 只返回已封禁用户',
    onlyDisabled.data?.items?.length > 0 &&
      onlyDisabled.data.items.every((u) => !!u.disabled_at) &&
      onlyDisabled.data.items.some((u) => u.user_id === victimId),
    `total=${onlyDisabled.data?.total}`,
  );
  const onlyActive = await call('GET', '/admin/users?disabled=false&size=100', {
    token: adminTok,
  });
  check(
    'disabled=false 排除已封禁用户',
    onlyActive.data?.items?.length > 0 &&
      onlyActive.data.items.every((u) => !u.disabled_at) &&
      !onlyActive.data.items.some((u) => u.user_id === victimId),
  );

  const [i1, i2, i3] = await Promise.all([
    // ① 揣着未过期 accessToken 打业务接口 → 401
    call('GET', '/ai/conversations', { token: victimTok }),
    // ② 重新登录 → 拒绝
    call('POST', '/auth/login', {
      body: { username: VICTIM_USER, password: PASSWORD },
    }),
    // ③ 用旧 refreshToken 续期 → 拒绝
    call('POST', '/auth/refresh', { body: { refreshToken: victimRefresh } }),
  ]);
  check(
    '① 旧 accessToken 立即失效 401',
    i1.status === 401,
    `实际 ${i1.status}`,
  );
  check('② 被封后不能登录 401', i2.status === 401, `实际 ${i2.status}`);
  check(
    '② 登录错误信息含禁用提示',
    /禁用/.test(i2.json?.message ?? ''),
    i2.json?.message,
  );
  check('③ 被封后不能刷新 401', i3.status === 401, `实际 ${i3.status}`);

  // 自锁防护
  const selfBan = await call('PATCH', `/admin/users/${adminId}/ban`, {
    token: adminTok,
    body: { banned: true },
  });
  check('不能封禁自己 400', selfBan.status === 400, `实际 ${selfBan.status}`);

  // 解封
  const unban = await call('PATCH', `/admin/users/${victimId}/ban`, {
    token: adminTok,
    body: { banned: false },
  });
  check('解封成功', unban.status === 200 && !unban.data?.user?.disabled_at);
  const relogin = await call('POST', '/auth/login', {
    body: { username: VICTIM_USER, password: PASSWORD },
  });
  check('解封后可以登录', !!relogin.data?.accessToken);
  const vTok = relogin.data?.accessToken;

  // ── 4. 改角色与自锁 ───────────────────────────────────────
  console.log('\n-- 4. 角色 --');
  const up = await call('PATCH', `/admin/users/${victimId}/role`, {
    token: adminTok,
    body: { role: 'root' },
  });
  check(
    '改角色 user → root',
    up.data?.user?.role === 'root',
    JSON.stringify(up.json),
  );

  const selfRole = await call('PATCH', `/admin/users/${adminId}/role`, {
    token: adminTok,
    body: { role: 'user' },
  });
  check(
    '不能改自己的角色 400（含自我降级）',
    selfRole.status === 400,
    `实际 ${selfRole.status}`,
  );

  // 现在有两个 root：用 victim(root) 把 admin 降级 —— 这是**允许**的（还剩一个可用 root）
  const vTokRoot = (
    await call('POST', '/auth/login', {
      body: { username: VICTIM_USER, password: PASSWORD },
    })
  ).data?.accessToken;
  const demoteOther = await call('PATCH', `/admin/users/${adminId}/role`, {
    token: vTokRoot,
    body: { role: 'user' },
  });
  check(
    '可以降级另一个 root（还存在其他可用 root）',
    demoteOther.status === 200,
    JSON.stringify(demoteOther.json),
  );
  // 还原
  sql(`UPDATE \`user\` SET role='root' WHERE username='${ADMIN_USER}'`);
  const adminTok2 = (
    await call('POST', '/auth/login', {
      body: { username: ADMIN_USER, password: PASSWORD },
    })
  ).data?.accessToken;
  await call('PATCH', `/admin/users/${victimId}/role`, {
    token: adminTok2,
    body: { role: 'user' },
  });

  // ── 5. 重置密码 ───────────────────────────────────────────
  console.log('\n-- 5. 重置密码 --');
  const preReset = await call('POST', '/auth/login', {
    body: { username: VICTIM_USER, password: PASSWORD },
  });
  const staleRefresh = preReset.data?.refreshToken;

  const reset = await call('POST', `/admin/users/${victimId}/password`, {
    token: adminTok2,
    body: { newPassword: NEW_PASSWORD },
  });
  check(
    '重置成功且不回显密码',
    reset.data?.reset === true &&
      !JSON.stringify(reset.json).includes(NEW_PASSWORD),
  );

  const oldPwd = await call('POST', '/auth/login', {
    body: { username: VICTIM_USER, password: PASSWORD },
  });
  // 只断言「登录失败」，不限定状态码：本项目密码错误走的是 400（LocalStrategy 抛
  // BadRequestException），而不是 401。这是既有行为，不是本次改动引入的。
  check(
    '旧密码失效（登录失败且无 token）',
    oldPwd.status !== 200 && !oldPwd.data?.accessToken,
    `实际 ${oldPwd.status}`,
  );
  const newPwd = await call('POST', '/auth/login', {
    body: { username: VICTIM_USER, password: NEW_PASSWORD },
  });
  check('新密码可登录', !!newPwd.data?.accessToken);
  const stale = await call('POST', '/auth/refresh', {
    body: { refreshToken: staleRefresh },
  });
  check('重置后旧会话被吊销 401', stale.status === 401, `实际 ${stale.status}`);

  // ── 6. 提权红线 ───────────────────────────────────────────
  console.log('\n-- 6. 提权红线 --');
  const vTok2 = newPwd.data?.accessToken;
  const escalate = await call('PATCH', `/user/${victimId}`, {
    token: vTok2,
    body: { role: 'root' },
  });
  check(
    'PATCH /user/:id 传 role 被拒（forbidNonWhitelisted → 400）',
    escalate.status === 400,
    `实际 ${escalate.status}`,
  );
  check(
    '提权未生效（库里仍是 user）',
    sql(`SELECT role FROM \`user\` WHERE username='${VICTIM_USER}'`) === 'user',
  );

  // ── 7. 级联删号 ───────────────────────────────────────────
  console.log('\n-- 7. 级联删号 --');
  // 先给 victim 造一点各类数据，否则「无孤儿」是空验证
  await call('POST', '/track', {
    token: vTok2,
    body: { events: [{ event: 'e2e.probe', page: 'Home', props: { n: 1 } }] },
  });
  /*
   * AI 数据用 SQL 直接插，**不走 `POST /ai/chat`**。
   *
   * 踩过的坑：一开始是调 `POST /ai/chat` 造数据，结果脚本偶发报「留下孤儿埋点行」。
   * 原因是那条接口是 SSE 流，网关在**流结束时**才写 `ai.chat` 埋点；
   * 而清理跑在流结束之前 —— 流结束后才落库的那一行就成了孤儿。
   * 这是**脚本的竞态**，不是产品 bug（`track_event` 本来就有意保留，
   * 已删用户的行会退化成 LEFT JOIN 能识别的「已注销」），但它让脚本不可重复。
   * 级联删除只看 `user_id`，数据从哪来无所谓，直接插更快也更确定。
   */
  sql(
    `INSERT INTO ai_conversation (id, user_id, title, create_time, update_time)
       VALUES (UUID(), '${victimId}', 'e2e 造数', NOW(), NOW())`,
  );
  const convId = sql(
    `SELECT id FROM ai_conversation WHERE user_id='${victimId}' LIMIT 1`,
  );
  sql(
    `INSERT INTO ai_message (id, conversation_id, user_id, role, content, create_time)
       VALUES (UUID(), '${convId}', '${victimId}', 'user', 'e2e', NOW()),
              (UUID(), '${convId}', '${victimId}', 'assistant', 'e2e', NOW())`,
  );
  // ai_usage.id 是 int AUTO_INCREMENT（与 ai_conversation 的 uuid 主键不同），别传 UUID
  sql(
    `INSERT INTO ai_usage (user_id, stat_date, request_count, prompt_tokens, completion_tokens)
       VALUES ('${victimId}', CURDATE(), 1, 10, 5)`,
  );
  sql(
    `INSERT INTO user_anime (id, user_id, bangumi_id, status, create_time, update_time)
       VALUES (UUID(), '${victimId}', 10380, 'wish', NOW(), NOW())`,
  );
  const ownedBefore = sql(
    `SELECT (SELECT COUNT(*) FROM track_event WHERE user_id='${victimId}')
          + (SELECT COUNT(*) FROM refresh_token WHERE user_id='${victimId}')
          + (SELECT COUNT(*) FROM ai_conversation WHERE user_id='${victimId}')
          + (SELECT COUNT(*) FROM ai_message WHERE user_id='${victimId}')
          + (SELECT COUNT(*) FROM ai_usage WHERE user_id='${victimId}')
          + (SELECT COUNT(*) FROM user_anime WHERE user_id='${victimId}')`,
  );
  console.log(`    （删号前 victim 名下可核查数据行数：${ownedBefore}）`);
  check(
    '删号前确实造出了多表数据（否则「无孤儿」是空验证）',
    Number(ownedBefore) >= 6,
    `实际 ${ownedBefore}`,
  );

  const del = await call('DELETE', `/admin/users/${victimId}`, {
    token: adminTok2,
  });
  check('删号成功', del.data?.deleted === true, JSON.stringify(del.json));

  const TABLES = [
    'user',
    'ai_message',
    'ai_conversation',
    'ai_usage',
    'user_anime',
    'media_source',
    'refresh_token',
    'group_user_map',
    'playback_session',
  ];
  const leftovers = TABLES.map(
    (t) =>
      `${t}=${sql(
        `SELECT COUNT(*) FROM \`${t}\` WHERE user_id='${victimId}'`,
      )}`,
  ).filter((s) => !s.endsWith('=0'));
  check('9 张表均无该用户残留', leftovers.length === 0, leftovers.join(' '));
  // group / track_event 是**有意保留**的
  const kept = sql(
    `SELECT COUNT(*) FROM track_event WHERE user_id='${victimId}'`,
  );
  check(
    'track_event 有意保留（埋点不属于个人数据）',
    Number(kept) > 0 || ownedBefore === '0',
    `实际 ${kept}`,
  );

  // ── 8. 审计 ───────────────────────────────────────────────
  console.log('\n-- 8. 审计 --');
  const logs = await call('GET', '/admin/users/audit?limit=50', {
    token: adminTok2,
  });
  const actions = (logs.data ?? []).map((l) => l.action);
  check(
    '有 user.ban 记录',
    actions.includes('user.ban'),
    JSON.stringify(actions),
  );
  check('有 user.role 记录', actions.includes('user.role'));
  check('有 user.password 记录', actions.includes('user.password'));
  check('有 user.delete 记录', actions.includes('user.delete'));
  const logRaw = JSON.stringify(logs.json);
  check(
    '审计 detail 不含任何密码明文',
    !logRaw.includes(PASSWORD) && !logRaw.includes(NEW_PASSWORD),
  );
  const roleLog = (logs.data ?? []).find((l) => l.action === 'user.role');
  check(
    '审计记了 from/to',
    !!roleLog?.detail?.from && !!roleLog?.detail?.to,
    JSON.stringify(roleLog?.detail),
  );
  check(
    '审计有 actor 快照（actor_username）',
    !!roleLog?.actor_username,
    JSON.stringify(roleLog),
  );

  // ── 清理 ──────────────────────────────────────────────────
  console.log('\n-- 清理测试数据 --');
  /*
   * 注意：产品行为是**有意保留** `track_event`（埋点不属于个人数据，已删用户的行会
   * 退化成「已注销」，`statsTopUsers` 的 LEFT JOIN 能正确显示）。
   * 但脚本自己造的数据必须清掉 —— 「产品会留下这些行」不等于「可以往开发库里留垃圾」。
   * 上面的断言已经验证过保留行为，这里只是收拾现场。
   */
  sql(
    `DELETE FROM track_event WHERE user_id='${victimId}' OR user_id IN (SELECT user_id FROM \`user\` WHERE username='${ADMIN_USER}')`,
  );
  sql(
    `DELETE FROM admin_audit_log WHERE actor_username IN ('${ADMIN_USER}','${VICTIM_USER}') OR target_id='${victimId}'`,
  );
  sql(
    `DELETE FROM refresh_token WHERE user_id IN (SELECT user_id FROM \`user\` WHERE username='${ADMIN_USER}')`,
  );
  sql(`DELETE FROM \`user\` WHERE username='${ADMIN_USER}'`);
  const residual = sql(
    `SELECT COUNT(*) FROM \`user\` WHERE username IN ('${ADMIN_USER}','${VICTIM_USER}')`,
  );
  check('测试账号已清理', residual === '0', `残留 ${residual}`);

  // 先断言「自己造的埋点清干净了」—— 这是本脚本能控制的部分
  const mine = sql(
    `SELECT COUNT(*) FROM track_event WHERE user_id='${victimId}' OR user_id IN (SELECT user_id FROM \`user\` WHERE username='${ADMIN_USER}')`,
  );
  check('自己造的埋点行已清干净', mine === '0', `残留 ${mine}`);
  // 再断言「没有新增孤儿」—— 基线之差，不受共享库里别人的残留影响
  const orphansAfter = Number(
    sql(
      'SELECT COUNT(*) FROM track_event WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT user_id FROM `user`)',
    ),
  );
  check(
    '本次运行未新增孤儿埋点行',
    orphansAfter <= orphansBefore,
    `基线 ${orphansBefore} → 现在 ${orphansAfter}`,
  );
  if (orphansAfter > 0) {
    console.log(
      `    （提示：库里另有 ${orphansAfter} 行历史孤儿埋点，非本次产生 —— 别人跑完没清）`,
    );
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('\n脚本异常（后端是否已启动？mysql 是否可用？）', e.message);
  /*
   * 兜底清理。**不能只删 `user` 行** —— 中途崩溃时用户可能已经被删了，
   * 而它名下的埋点/审计行还在，会永久污染开发库（孤儿行）。
   * 用模块级记下的 id 按 id 删，才能覆盖这种情况。
   */
  const ids = [adminIdForCleanup, victimIdForCleanup].filter(Boolean);
  const inList = ids.map((i) => `'${i}'`).join(',');
  try {
    if (inList) {
      sql(`DELETE FROM track_event WHERE user_id IN (${inList})`);
      sql(`DELETE FROM admin_audit_log WHERE target_id IN (${inList})`);
      sql(`DELETE FROM refresh_token WHERE user_id IN (${inList})`);
    }
    sql(
      `DELETE FROM admin_audit_log WHERE actor_username IN ('${ADMIN_USER}','${VICTIM_USER}')`,
    );
    sql(
      `DELETE FROM \`user\` WHERE username IN ('${ADMIN_USER}','${VICTIM_USER}')`,
    );
    const left = sql(
      'SELECT COUNT(*) FROM track_event WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT user_id FROM `user`)',
    );
    console.error(`（兜底清理完成；残留孤儿埋点行 ${left}）`);
  } catch {
    /* 清理本身失败就无能为力了，至少把原始异常暴露出来 */
  }
  process.exit(1);
});
