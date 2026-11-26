import { api } from './common.js';

const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const errorBox = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  loginBtn.disabled = true;
  loginBtn.textContent = '登录中…';
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: { username: usernameInput.value.trim(), password: passwordInput.value }
    });
    location.href = user.role === 'teacher' ? '/admin.html' : '/workspace.html';
  } catch (err) {
    errorBox.textContent = err.message || '登录失败';
    loginBtn.disabled = false;
    loginBtn.textContent = '登 录';
  }
});

usernameInput.focus();
