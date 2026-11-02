import path from 'node:path';
import { parseEnv } from 'node:util';
import { CredentialSetup } from './credential-setup.js';
import { authorizeTwitch } from './twitch-auth.js';

const DEADLINE_MS = 10 * 60 * 1000;
const clientId = value => typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value);
const pending = stage => stage === 'starting' || stage === 'waiting';
const fixedReasons = new Map([
  ['Twitch authorization denied', 'access_denied'],
  ['Twitch device code expired', 'expired'],
  ['Authorization cancelled', 'cancelled'],
  ['Authorization missing required scopes', 'missing_scopes'],
  ['Authorize the expected Twitch account', 'account_mismatch'],
  ['Authorize the configured broadcaster account', 'account_mismatch'],
  ['Twitch authorization validation failed', 'invalid_validation'],
]);

/** Private operator endpoint only: status() includes a short-lived user code while waiting. */
export class TwitchDeviceFlow {
  constructor({ root, env = {}, fetcher = fetch, now = Date.now } = {}) {
    this.setup = new CredentialSetup({ root });
    this.root = root;
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
    this.current = { stage: 'idle' };
  }
  status() {
    if (this.current.stage === 'waiting' && this.now() >= this.current.expires_at) {
      this.reason = 'expired';
      this.current = { stage: 'failed', reason: 'expired' };
      this.controller?.abort();
    }
    return structuredClone(this.current);
  }
  start() {
    if (this.closed) return Promise.resolve({ stage: 'failed', reason: 'closed' });
    if (this.task) return this.ready ?? Promise.resolve(this.status());
    if (this.current.stage === 'authorized') return Promise.resolve(this.status());
    this.current = { stage: 'starting' };
    this.reason = undefined;
    this.lastHTTPStatus = undefined;
    this.controller = new AbortController();
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    this.deadline = setTimeout(() => this.cancel('deadline_exceeded'), DEADLINE_MS);
    this.deadline.unref?.();
    this.task = this.run().catch(error => {
      if (this.current.stage !== 'authorized') {
        const reason = this.reason ?? fixedReasons.get(error?.message) ??
          (this.lastHTTPStatus >= 400 ? 'provider_rejected' : 'authorization_failed');
        this.current = { stage: 'failed', reason,
          ...(Number.isInteger(this.lastHTTPStatus) ? { http_status: this.lastHTTPStatus } : {}) };
      }
    }).finally(() => {
      clearTimeout(this.deadline);
      clearTimeout(this.expiry);
      this.resolveReady?.(this.status());
      this.task = null;
      this.ready = null;
      this.resolveReady = null;
    });
    return this.ready;
  }
  async run() {
    let saved;
    try {
      await this.setup.assertStorage();
      saved = parseEnv(await this.setup.readPrivate());
    } catch { this.reason = 'storage_unavailable'; throw Error('Storage is unavailable'); }
    this.controller.signal.throwIfAborted();
    // Only public identifiers come from caller configuration. Old OAuth tokens are never adopted.
    const ext = saved.TWITCH_EXT_CLIENT_ID || this.env.TWITCH_EXT_CLIENT_ID;
    const selected = saved.TWITCH_CLIENT_ID || this.env.TWITCH_CLIENT_ID || ext;
    if (!clientId(selected) || ext && (!clientId(ext) || selected !== ext)) {
      this.reason = 'client_mismatch'; throw Error('Use the new extension client ID');
    }
    try { await this.setup.save({}); }
    catch { this.reason = 'storage_unavailable'; throw Error('Storage is unavailable'); }
    this.controller.signal.throwIfAborted();
    const authEnv = { TWITCH_CLIENT_ID: selected,
      ...(saved.TWITCH_BROADCASTER_ID ? { TWITCH_BROADCASTER_ID: saved.TWITCH_BROADCASTER_ID } : {}) };
    const result = await authorizeTwitch(authEnv, {
      envFile: path.join(this.root, '.env'), expectedLogin: 'wilf_lin', bindExtensionOwner: true,
      disableLive: true, signal: this.controller.signal, now: this.now,
      fetcher: async (url, init = {}) => {
        const response = await this.fetcher(url, { ...init,
          signal: AbortSignal.any([this.controller.signal, ...(init.signal ? [init.signal] : [])]) });
        this.lastHTTPStatus = Number.isInteger(response.status) ? response.status : undefined;
        return response;
      },
      onCode: info => {
        let url;
        try { url = new URL(info.verification_uri); } catch { /* Fixed error below. */ }
        if (!url || url.protocol !== 'https:' || !['twitch.tv', 'www.twitch.tv', 'id.twitch.tv'].includes(url.hostname) ||
            url.username || url.password || url.port || url.hash ||
            [...url.searchParams].some(([key, value]) =>
              !(key === 'public' && value === 'true' || key === 'device-code' && value === info.user_code)) ||
            [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1) ||
            !['/activate', '/activate/'].includes(url.pathname) ||
            typeof info.user_code !== 'string' || !/^[A-Za-z0-9-]{4,64}$/.test(info.user_code) ||
            !Number.isFinite(info.expires_in) || info.expires_in <= 0) {
          this.reason = 'invalid_device_response'; throw Error('Invalid device response');
        }
        // Twitch's documented URI embeds the user code. Expose only the canonical activation page.
        url.search = '';
        this.controller.signal.throwIfAborted();
        const lifetime = Math.min(info.expires_in * 1000, DEADLINE_MS);
        this.current = { stage: 'waiting', verification_uri: url.href,
          user_code: info.user_code, expires_at: this.now() + lifetime };
        this.expiry = setTimeout(() => this.cancel('expired'), lifetime);
        this.expiry.unref?.();
        this.resolveReady?.(this.status());
      },
      beforePersist: async () => {
        try {
          await this.setup.assertStorage();
          const current = parseEnv(await this.setup.readPrivate());
          const currentExt = current.TWITCH_EXT_CLIENT_ID || this.env.TWITCH_EXT_CLIENT_ID;
          if (currentExt && currentExt !== selected || current.TWITCH_CLIENT_ID && current.TWITCH_CLIENT_ID !== selected) {
            this.reason = 'client_changed'; throw Error('Client changed');
          }
        } catch {
          this.reason ??= 'storage_unavailable';
          throw Error('Storage is unavailable');
        }
      },
    });
    this.controller.signal.throwIfAborted();
    this.current = { stage: 'authorized', userId: result.userId, scopes: result.scopes };
  }
  cancel(reason) {
    if (!pending(this.current.stage)) return;
    this.reason = reason;
    this.current = { stage: 'failed', reason };
    this.controller?.abort();
    this.resolveReady?.(this.status());
  }
  stop() { this.cancel('cancelled'); }
  close() { this.closed = true; this.cancel('closed'); }
}
