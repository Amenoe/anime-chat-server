/**
 * 双 token 鉴权端到端验收脚本（真实打接口，非 mock）
 *
 * 用法：先启动后端，再执行
 *   node scripts/auth-e2e.mjs
 *   BASE=http://127.0.0.1:3000/api node scripts/auth-e2e.mjs
 *
 * 覆盖：注册 → 登录 → accessToken 鉴权 → refreshToken 不能访问业务接口 →
 *       刷新轮换 → 旧 refreshToken 复用被拒并整户吊销 → 登出吊销 →
 *       缺参校验 → 改密吊销全部会话 → 新密码登录 → 删号清理
 *
 * 测试账号会在结束时删除，本地库不留数据。退出码非 0 表示有用例失败。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000/api';
const USERNAME = `e2e${Date.now().toString().slice(-6)}`;
const PASSWORD = 'test1234';
const NEW_PASSWORD = 'newpass123';

let pass = 0;
let fail = 0;

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

const main = async () => {
  console.log(`\n== 目标 ${BASE} · 测试账号 ${USERNAME} ==`);

  // 1. 注册
  const reg = await call('POST', '/user/register', {
    body: { username: USERNAME, password: PASSWORD, nickname: 'e2e测试' },
  });
  check(
    '注册成功',
    reg.status === 200 || reg.status === 201,
    JSON.stringify(reg.json),
  );

  // 2. 登录
  const login = await call('POST', '/auth/login', {
    body: { username: USERNAME, password: PASSWORD },
  });
  const A = login.data;
  check('登录返回 200', login.status === 200 || login.status === 201);
  check('返回 accessToken', !!A?.accessToken);
  check('返回 refreshToken', !!A?.refreshToken);
  check('token 为 accessToken 兼容别名', A?.token === A?.accessToken);
  check(
    'expiresIn = 7200（2h）',
    A?.expiresIn === 7200,
    `实际 ${A?.expiresIn}`,
  );
  check(
    'refreshExpiresIn = 2592000（30d）',
    A?.refreshExpiresIn === 2592000,
    `实际 ${A?.refreshExpiresIn}`,
  );
  const uid = A?.user_id || A?.user?.user_id;

  // 3. accessToken 可访问业务接口
  const me = await call('GET', `/user/${uid}`, { token: A.accessToken });
  check('accessToken 可访问业务接口', me.status === 200);

  // 4. refreshToken 不能访问业务接口（typ 校验）
  const withRefresh = await call('GET', `/user/${uid}`, {
    token: A.refreshToken,
  });
  check(
    'refreshToken 访问业务接口被拒 401',
    withRefresh.status === 401,
    `实际 ${withRefresh.status}`,
  );

  // 5. 刷新轮换
  const r1 = await call('POST', '/auth/refresh', {
    body: { refreshToken: A.refreshToken },
  });
  const B = r1.data;
  check(
    '刷新成功',
    r1.status === 200 || r1.status === 201,
    JSON.stringify(r1.json),
  );
  check(
    '刷新换发新 refreshToken',
    !!B?.refreshToken && B.refreshToken !== A.refreshToken,
  );
  check(
    '刷新换发新 accessToken',
    !!B?.accessToken && B.accessToken !== A.accessToken,
  );
  const afterRefresh = await call('GET', `/user/${uid}`, {
    token: B.accessToken,
  });
  check('新 accessToken 可用', afterRefresh.status === 200);

  // 6. 旧 refreshToken 复用 → 拒绝并整户吊销（泄露检测）
  const reuse = await call('POST', '/auth/refresh', {
    body: { refreshToken: A.refreshToken },
  });
  check(
    '旧 refreshToken 复用被拒 401',
    reuse.status === 401,
    `实际 ${reuse.status}`,
  );
  const afterNuke = await call('GET', `/user/${uid}`, { token: B.accessToken });
  check(
    '复用检测后旧 accessToken 仍有效（自然过期）',
    afterNuke.status === 200,
  );

  // 7. 重新登录 → 主动登出吊销
  const login2 = await call('POST', '/auth/login', {
    body: { username: USERNAME, password: PASSWORD },
  });
  const C = login2.data;
  check('复用吊销后可重新登录', !!C?.refreshToken);
  const out = await call('POST', '/auth/logout', {
    body: { refreshToken: C.refreshToken },
  });
  check(
    '登出返回 revoked=true',
    out.data?.revoked === true,
    JSON.stringify(out.json),
  );
  const afterLogout = await call('POST', '/auth/refresh', {
    body: { refreshToken: C.refreshToken },
  });
  check(
    '登出后 refreshToken 失效 401',
    afterLogout.status === 401,
    `实际 ${afterLogout.status}`,
  );

  // 8. 参数校验
  const out2 = await call('POST', '/auth/logout', { body: {} });
  check('空 body 登出返回 revoked=false', out2.data?.revoked === false);
  const badRefresh = await call('POST', '/auth/refresh', { body: {} });
  check(
    '缺 refreshToken 刷新返回 400',
    badRefresh.status === 400,
    `实际 ${badRefresh.status}`,
  );

  // 9. 改密吊销全部会话
  const login3 = await call('POST', '/auth/login', {
    body: { username: USERNAME, password: PASSWORD },
  });
  const D = login3.data;
  const upd = await call('PATCH', `/user/${uid}`, {
    body: { password: NEW_PASSWORD },
    token: D.accessToken,
  });
  check('改密成功', upd.status === 200, JSON.stringify(upd.json));
  const afterPwd = await call('POST', '/auth/refresh', {
    body: { refreshToken: D.refreshToken },
  });
  check(
    '改密后旧 refreshToken 失效 401',
    afterPwd.status === 401,
    `实际 ${afterPwd.status}`,
  );
  const relogin = await call('POST', '/auth/login', {
    body: { username: USERNAME, password: NEW_PASSWORD },
  });
  check('新密码可登录', !!relogin.data?.refreshToken);

  // 10. 删号清理（后端应同时作废其 refreshToken）
  const cleanup = await call('DELETE', `/user/${uid}`, {
    token: relogin.data.accessToken,
  });
  check('清理测试账号', cleanup.status === 200, `实际 ${cleanup.status}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('\n脚本异常（后端是否已启动？）', e.message);
  process.exit(1);
});
