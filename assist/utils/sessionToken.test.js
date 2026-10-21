const test = require('node:test');
const assert = require('node:assert');
const {verifySessionToken} = require('./sessionToken');

// Issued by backend/pkg/token Tokenizer.Compose with secret "interop-secret" for
// session 7349218123456789012: VALID expires in 2100, EXPIRED expired in 2020.
const SECRET = 'interop-secret';
const VALID = '1ju3ced5pb7ys.-16.1gcmxpmo0.EfwYovVpQEba7UG8B2DtEcyaBrr9u7t5nQSqdqiRkWwH';
const EXPIRED = '1ju3ced5pb7ys.5.k4ujaio0.D31enjXiZwC3a6BX898MTSSMg2Lt5VrNfXo3FZQQUBoR';

test('accepts a backend-issued token and returns its session ID', () => {
    assert.strictEqual(verifySessionToken(VALID, SECRET), '7349218123456789012');
});

test('rejects a token signed with another secret', () => {
    assert.strictEqual(verifySessionToken(VALID, 'other-secret'), null);
});

test('rejects an expired token', () => {
    assert.strictEqual(verifySessionToken(EXPIRED, SECRET), null);
});

test('rejects a token whose session ID was changed', () => {
    assert.strictEqual(verifySessionToken('1ju3ced5pb7yt' + VALID.slice(13), SECRET), null);
});

test('rejects malformed input', () => {
    for (const token of [undefined, null, '', 'a.b.c', 'a.b.c.d', 123, {}]) {
        assert.strictEqual(verifySessionToken(token, SECRET), null);
    }
    assert.strictEqual(verifySessionToken(VALID, ''), null);
});
