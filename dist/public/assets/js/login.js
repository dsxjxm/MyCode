import { api } from './common.js';

const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const errorBox = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');

const MAX_QUEUE_WAIT_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 登录限流：服务端并发超阈值时返回 202（queued=true），
// 这里自动「请稍候」并按 retryAfterMs 重试，形成排队体验。
async function submitLogin(username, password) {
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username, password }
    });
    if (!data || !data.queued) return data;

    attempts += 1;
    const message = data.message || '当前登录人数较多，请稍候…';
    errorBox.textContent = `${message}（自动排队重试第 ${attempts} 次）`;
    loginBtn.textContent = '请稍候…';

    if (Date.now() - startedAt > MAX_QUEUE_WAIT_MS) {
      throw new Error('当前登录人数较多，请稍后再试');
    }
    const wait = Math.min(3000, Math.max(250, Number(data.retryAfterMs) || 600));
    await sleep(wait + Math.floor(Math.random() * 150));
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  loginBtn.disabled = true;
  loginBtn.textContent = '登录中…';
  try {
    const { user } = await submitLogin(usernameInput.value.trim(), passwordInput.value);
    location.href = user.role === 'teacher' ? '/admin.html' : '/workspace.html';
  } catch (err) {
    errorBox.textContent = err.message || '登录失败';
    loginBtn.disabled = false;
    loginBtn.textContent = '登 录';
  }
});

usernameInput.focus();
