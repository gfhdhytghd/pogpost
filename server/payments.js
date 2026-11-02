import { createHmac, timingSafeEqual } from 'node:crypto';
import { domainError, BIT_TIERS } from './config.js';

export const PAYMENTS_LIVE = false;
const fail = (code, message, status = 400) => { throw domainError(code, message, status); };

/** Real-money integration is inert unless explicitly enabled by its owner. */
export class LivePayments {
  constructor({ live = false, helix, extensionSecret, channelId, now = Date.now, state, store } = {}) {
    this.live = live === true;
    this.helix = helix;
    this.extensionSecret = extensionSecret;
    this.channelId = String(channelId ?? '');
    this.now = now;
    this.store = store;
    this.state = store?.read() ?? state ?? { rewardId: null, credits: {}, redemptions: {}, bitsTransactions: {} };
    this._operations = new Map();
    this._save();
  }
  _save() { this.store?.replace(this.state); }
  enabled() { if (!this.live) fail('payments_disabled', 'Real payments are disabled.', 403); }
  async ensureReward(price = 200) {
    this.enabled();
    if (!Number.isInteger(price) || price < 1) fail('invalid_price', 'Invalid reward price.');
    const body = { title: 'Seal a note', cost: price, is_user_input_required: false };
    const result = await this.helix.ensureReward(price);
    const reward = result?.data?.[0] ?? result;
    if (!reward?.id && !this.state.rewardId) fail('invalid_reward_response', 'Reward creation failed.', 502);
    this.state.rewardId = reward?.id ?? this.state.rewardId;
    this._save();
    return { id: this.state.rewardId, ...body };
  }
  grantCredit(redemption) {
    this.enabled();
    const id = redemption?.id;
    const userId = redemption?.user_id;
    if (typeof id !== 'string' || !id || typeof userId !== 'string' || !userId || redemption.broadcaster_user_id !== this.channelId || redemption.reward?.id !== this.state.rewardId || redemption.status && redemption.status !== 'unfulfilled') fail('invalid_redemption', 'Invalid redemption.');
    if (this.state.redemptions[id]) return { ...this.state.redemptions[id], duplicate: true };
    const entry = { id, userId, status: 'available', rewardId: this.state.rewardId };
    this.state.redemptions[id] = entry;
    (this.state.credits[userId] ??= []).push(id);
    this._save();
    return { ...entry, duplicate: false };
  }
  credit(userId) {
    this.enabled();
    if (!userId) fail('identity_required', 'Share your Twitch identity first.', 403);
    const id = (this.state.credits[userId] ?? []).find(id => this.state.redemptions[id]?.status === 'available');
    if (!id) fail('credit_required', 'Redeem a seal credit first.', 402);
    this.state.redemptions[id].status = 'reserved';
    this._save();
    return id;
  }
  async status(userId, id, status) {
    this.enabled();
    if (!['FULFILLED', 'CANCELED'].includes(status)) fail('invalid_redemption_status', 'Invalid redemption status.');
    const pending = this._operations.get(id);
    if (pending) { await pending; return this.status(userId, id, status); }
    const operation = this._setStatus(userId, id, status);
    this._operations.set(id, operation);
    try { return await operation; } finally { this._operations.delete(id); }
  }
  async _setStatus(userId, id, status) {
    const redemption = this.state.redemptions[id];
    if (!redemption || redemption.userId !== userId) fail('invalid_redemption', 'Redemption identity mismatch.', 403);
    const target = status === 'FULFILLED' ? 'fulfilled' : 'canceled';
    if (redemption.status === target) return { id, status, duplicate: true };
    if (redemption.status === 'canceled' || redemption.status === 'fulfilled') fail('redemption_final', 'Redemption has a final status.', 409);
    await this.helix.updateRedemption(id, status, redemption.rewardId);
    redemption.status = target;
    this._save();
    return { id, status, duplicate: false };
  }
  fulfill(userId, id) { return this.status(userId, id, 'FULFILLED'); }
  cancel(userId, id) { return this.status(userId, id, 'CANCELED'); }
  verifyBits(receipt, { userId, productId, amount } = {}) {
    this.enabled();
    if (!userId || !productId || !BIT_TIERS.includes(amount)) fail('invalid_bits_expectation', 'Invalid Bits purchase.');
    if (typeof receipt !== 'string' || receipt.length > 16384 || !this.extensionSecret) fail('invalid_receipt', 'Invalid Bits receipt.', 401);
    const parts = receipt.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) fail('invalid_receipt', 'Invalid Bits receipt.', 401);
    let header, payload;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); }
    catch { fail('invalid_receipt', 'Invalid Bits receipt.', 401); }
    if (!header || typeof header !== 'object' || Array.isArray(header) || !payload || typeof payload !== 'object' || Array.isArray(payload) || header.alg !== 'HS256') fail('invalid_receipt', 'Invalid receipt signature algorithm.', 401);
    const signature = Buffer.from(parts[2], 'base64url');
    const expected = createHmac('sha256', Buffer.from(this.extensionSecret, 'base64')).update(`${parts[0]}.${parts[1]}`).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) fail('invalid_receipt', 'Invalid receipt signature.', 401);
    const now = this.now() / 1000;
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= now || payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > now)) fail('expired_receipt', 'Bits receipt has expired.', 401);
    const data = payload.data ?? payload;
    const transactionId = data.transactionId;
    const product = data.product;
    const channel = data.channelId ?? data.broadcasterId ?? data.broadcaster_id;
    if (data.userId !== String(userId) || String(channel) !== this.channelId || product?.sku !== productId || product?.cost?.amount !== amount || product?.cost?.type?.toLowerCase() !== 'bits' || typeof transactionId !== 'string' || transactionId.length < 1 || transactionId.length > 200) fail('receipt_mismatch', 'Receipt does not match this purchase.', 403);
    if (this.state.bitsTransactions[transactionId]) fail('receipt_replayed', 'Bits receipt was already used.', 409);
    this.state.bitsTransactions[transactionId] = { userId: String(userId), productId, amount, verified_at: this.now() };
    this._save();
    return { mode: 'bits', amount, txn_id: transactionId };
  }
}
