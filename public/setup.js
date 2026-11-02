const form = document.querySelector('#credentials-form');
const fields = document.querySelector('#credentials-fields');
const secret = document.querySelector('#extension-secret');
const status = document.querySelector('#setup-status');
const authButton = document.querySelector('#start-twitch-auth');
const authDetails = document.querySelector('#device-auth-details');
const deviceCode = document.querySelector('#device-user-code');
const copyDeviceCode = document.querySelector('#copy-device-code');
const toggleDeviceCode = document.querySelector('#toggle-device-code');
const activationLink = document.querySelector('#twitch-activation-link');
const authStatus = document.querySelector('#twitch-auth-status');
let localReady = false;
let authGeneration = 0;
let authPollTimer;
let authExpiryTimer;
let codeRevealTimer;
let codeRevealUntil = 0;
const indicators = {
  TWITCH_EXT_CLIENT_ID: '#present-client',
  TWITCH_EXT_SECRET: '#present-secret',
  TWITCH_EXT_OWNER_ID: '#present-owner',
  TWITCH_BROADCASTER_ID: '#present-broadcaster',
};

function message(text, failed = false) {
  status.textContent = text;
  status.classList.toggle('error', failed);
}
function showPresence(result) {
  for (const [key, selector] of Object.entries(indicators)) {
    document.querySelector(selector).textContent = result?.present?.[key] === true
      ? 'Saved' : 'Not saved';
  }
}
function maskDeviceCode() {
  clearTimeout(codeRevealTimer);
  codeRevealUntil = 0;
  deviceCode.type = 'password';
  toggleDeviceCode.textContent = 'Show activation code';
  toggleDeviceCode.setAttribute('aria-pressed', 'false');
}
function clearDeviceCode() {
  deviceCode.value = '';
  maskDeviceCode();
  copyDeviceCode.disabled = true;
  toggleDeviceCode.disabled = true;
  authDetails.hidden = true;
  activationLink.hidden = true;
  activationLink.removeAttribute('href');
}
function stopAuthTimers() {
  clearTimeout(authPollTimer);
  clearTimeout(authExpiryTimer);
}
function authMessage(text, failed = false) {
  authStatus.textContent = text;
  authStatus.classList.toggle('error', failed);
}
function activationURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !['www.twitch.tv', 'twitch.tv'].includes(url.hostname) ||
        url.pathname.replace(/\/+$/, '') !== '/activate') return null;
    return url.origin + '/activate';
  } catch { return null; }
}
function showAuthorization(result, generation) {
  if (generation !== authGeneration) return;
  stopAuthTimers();
  const stage = result?.stage;
  const waiting = stage === 'waiting' || stage === 'starting';
  authButton.disabled = waiting || !localReady;
  const preserveReveal = stage === 'waiting' && deviceCode.type === 'text' &&
    codeRevealUntil > Date.now() && deviceCode.value === result.user_code &&
    activationURL(result.verification_uri);
  if (!preserveReveal) clearDeviceCode();
  if (waiting) {
    const rawExpiry = result.expires_at;
    const expiresAt = typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)
      ? rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry : null;
    if (expiresAt !== null && expiresAt <= Date.now()) {
      clearDeviceCode();
      authButton.disabled = !localReady;
      authMessage('Authorization expired. Start a new Twitch authorization.', true);
      return;
    }
    if (stage === 'waiting') {
      const href = activationURL(result.verification_uri);
      if (href && typeof result.user_code === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(result.user_code)) {
        deviceCode.value = result.user_code;
        copyDeviceCode.disabled = false;
        toggleDeviceCode.disabled = false;
        authDetails.hidden = false;
        activationLink.href = href;
        activationLink.hidden = false;
      }
      authMessage('Waiting for your approval on Twitch. Keep the activation code private.');
    } else authMessage('Starting Twitch authorization…');
    if (expiresAt !== null) authExpiryTimer = setTimeout(() => {
      if (generation !== authGeneration) return;
      authGeneration++;
      stopAuthTimers();
      clearDeviceCode();
      authButton.disabled = !localReady;
      authMessage('Authorization expired. Start a new Twitch authorization.', true);
    }, Math.min(expiresAt - Date.now(), 2147483647));
    authPollTimer = setTimeout(() => void readAuthorization(generation), 2000);
    return;
  }
  if (stage === 'authorized') {
    authMessage(typeof result.userId === 'string' && /^[0-9]{1,30}$/.test(result.userId)
      ? 'Authorized broadcaster user ID: ' + result.userId + '. Provider features remain disabled.'
      : 'Broadcaster authorization complete. Provider features remain disabled.');
  } else if (stage === 'idle') authMessage('Ready. Start authorization when you are ready to approve it on Twitch.');
  else authMessage('Authorization was not confirmed. Start again when you are ready.', true);
}
async function readAuthorization(generation) {
  try {
    const response = await fetch('/api/operator/auth', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw Error();
    showAuthorization(await response.json(), generation);
  } catch { showAuthorization({ stage: 'failed' }, generation); }
}
copyDeviceCode.addEventListener('click', async () => {
  if (copyDeviceCode.disabled || !deviceCode.value) return;
  const generation = authGeneration;
  try {
    await navigator.clipboard.writeText(deviceCode.value);
    if (generation === authGeneration && !copyDeviceCode.disabled)
      authMessage('Activation code copied. Paste it only on the Twitch activation page.');
  } catch {
    if (generation === authGeneration && !copyDeviceCode.disabled)
      authMessage('Copy was not confirmed. Select the masked code and copy it manually.', true);
  }
});
toggleDeviceCode.addEventListener('click', () => {
  if (toggleDeviceCode.disabled || !deviceCode.value) return;
  const reveal = deviceCode.type === 'password';
  if (!reveal) { maskDeviceCode(); return; }
  deviceCode.type = 'text';
  toggleDeviceCode.textContent = 'Hide activation code';
  toggleDeviceCode.setAttribute('aria-pressed', 'true');
  codeRevealUntil = Date.now() + 10000;
  codeRevealTimer = setTimeout(maskDeviceCode, 10000);
});
async function initialize() {
  try {
    const bootstrap = await fetch('/api/operator/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
    if (!bootstrap.ok) throw Error();
    const response = await fetch('/api/operator/credentials', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw Error();
    showPresence(await response.json());
    fields.disabled = false;
    message('Ready. Empty fields keep their saved values.');
    localReady = true;
    await readAuthorization(authGeneration);
  } catch {
    message('Setup is unavailable. Open this page directly from the local server.', true);
    authMessage('Authorization is unavailable. Open this page directly from the local server.', true);
  }
}
authButton.addEventListener('click', async () => {
  if (!localReady || authButton.disabled) return;
  const generation = ++authGeneration;
  stopAuthTimers();
  clearDeviceCode();
  authButton.disabled = true;
  authMessage('Starting Twitch authorization…');
  try {
    const response = await fetch('/api/operator/auth', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Sealed-Action': '1' },
      body: '{}',
    });
    if (!response.ok) throw Error();
    showAuthorization(await response.json(), generation);
  } catch { showAuthorization({ stage: 'failed' }, generation); }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const payload = {};
  for (const key of Object.keys(indicators)) {
    const value = form.elements.namedItem(key).value;
    if (value !== '') payload[key] = value;
  }
  fields.disabled = true;
  message('Saving privately…');
  try {
    const request = fetch('/api/operator/credentials', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Sealed-Action': '1' },
      body: JSON.stringify(payload),
    });
    // Remove the browser form copy immediately. Never display or retain a response payload.
    secret.value = '';
    delete payload.TWITCH_EXT_SECRET;
    const response = await request;
    secret.value = '';
    if (!response.ok) throw Error();
    const result = await response.json();
    if (result?.ok !== true) throw Error();
    showPresence(result);
    for (const key of Object.keys(indicators)) form.elements.namedItem(key).value = '';
    message('Saved privately. Restart the server yourself to load these credentials. Provider features remain disabled.');
  } catch {
    message('Save was not confirmed. Check the fields and local file permissions, then try again.', true);
  } finally {
    secret.value = '';
    delete payload.TWITCH_EXT_SECRET;
    fields.disabled = false;
  }
});
// Native validation can prevent submit. Clear the secret after that failed attempt too.
form.addEventListener('invalid', () => { secret.value = ''; }, true);
window.addEventListener('pagehide', () => {
  secret.value = '';
  authGeneration++;
  stopAuthTimers();
  clearDeviceCode();
});
void initialize();
