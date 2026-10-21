const crypto = require('crypto');

// Verifies the tracker session token issued by the backend on session start
// (backend/pkg/token/tokenizer.go): "<id>.<delay>.<expTime>.<sign>", the first
// three fields in base36 and sign = base58(HMAC-SHA256(TOKEN_SECRET, body)).

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
    let num = BigInt('0x' + (buf.length ? buf.toString('hex') : '0'));
    let out = '';
    while (num > 0n) {
        out = BASE58_ALPHABET[Number(num % 58n)] + out;
        num /= 58n;
    }
    for (let i = 0; i < buf.length && buf[i] === 0; i++) {
        out = '1' + out;
    }
    return out;
}

function parseBase36(str) {
    if (!/^-?[0-9a-z]+$/.test(str)) {
        return null;
    }
    const negative = str.startsWith('-');
    let num = 0n;
    for (const c of negative ? str.slice(1) : str) {
        num = num * 36n + BigInt(parseInt(c, 36));
    }
    return negative ? -num : num;
}

// Same grace period as the backend tokenizer's JUST_EXPIRED.
const EXPIRY_GRACE_MS = 30000n;

/**
 * Returns the session ID (decimal string) the token was issued for, or null if
 * the token is malformed, badly signed or expired.
 */
function verifySessionToken(token, secret) {
    if (typeof token !== 'string' || !secret) {
        return null;
    }
    const parts = token.split('.');
    if (parts.length !== 4) {
        return null;
    }
    const body = parts.slice(0, 3).join('.');
    const expected = base58Encode(crypto.createHmac('sha256', secret).update(body).digest());
    const given = Buffer.from(parts[3]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, Buffer.from(expected))) {
        return null;
    }
    const id = parseBase36(parts[0]);
    const expTime = parseBase36(parts[2]);
    if (id === null || expTime === null || expTime + EXPIRY_GRACE_MS <= BigInt(Date.now())) {
        return null;
    }
    return id.toString();
}

module.exports = {verifySessionToken};
