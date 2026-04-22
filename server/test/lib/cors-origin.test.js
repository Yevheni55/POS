import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Because cors-origin.js captures env at module-load time, each test scenario
// uses a cache-busted dynamic import so it can set env vars before loading.
let importCounter = 0;
async function loadCors({ allowLan, allowedOrigins, lanAllowedPorts } = {}) {
  if (allowLan === undefined) delete process.env.CORS_ALLOW_LAN;
  else process.env.CORS_ALLOW_LAN = allowLan;
  if (allowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = allowedOrigins;
  if (lanAllowedPorts === undefined) delete process.env.LAN_ALLOWED_PORTS;
  else process.env.LAN_ALLOWED_PORTS = lanAllowedPorts;

  importCounter += 1;
  const mod = await import(`../../lib/cors-origin.js?v=${importCounter}`);
  return mod;
}

function decide(fn, origin) {
  return new Promise((resolve, reject) => {
    fn(origin, (err, allow) => {
      if (err) reject(err);
      else resolve(Boolean(allow));
    });
  });
}

describe('corsOriginCallback — explicit allowlist', () => {
  it('accepts exact match from ALLOWED_ORIGINS env var', async () => {
    const { corsOriginCallback } = await loadCors({
      allowedOrigins: 'https://pos.example.com,https://admin.example.com',
    });
    assert.equal(await decide(corsOriginCallback, 'https://pos.example.com'), true);
    assert.equal(await decide(corsOriginCallback, 'https://admin.example.com'), true);
  });

  it('rejects origins not in explicit allowlist when LAN is disabled', async () => {
    const { corsOriginCallback } = await loadCors({
      allowedOrigins: 'https://pos.example.com',
    });
    assert.equal(await decide(corsOriginCallback, 'https://attacker.example.com'), false);
    assert.equal(await decide(corsOriginCallback, 'http://192.168.1.10:3080'), false);
  });

  it('allows no-origin requests (server-to-server, curl)', async () => {
    const { corsOriginCallback } = await loadCors({});
    assert.equal(await decide(corsOriginCallback, undefined), true);
  });
});

describe('corsOriginCallback — LAN allowlist tightening', () => {
  it('rejects file:// origin even when LAN is enabled', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    assert.equal(await decide(corsOriginCallback, 'file:///C:/evil.html'), false);
  });

  it('rejects chrome-extension:// origin even when LAN is enabled', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    assert.equal(
      await decide(corsOriginCallback, 'chrome-extension://abcdefghijklmnop/index.html'),
      false,
    );
  });

  it('rejects http://192.168.1.10:8080 (port not in default whitelist)', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    assert.equal(await decide(corsOriginCallback, 'http://192.168.1.10:8080'), false);
  });

  it('accepts http://192.168.1.10:3080 (LAN IP + default allowed port)', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    assert.equal(await decide(corsOriginCallback, 'http://192.168.1.10:3080'), true);
  });

  it('accepts https://10.0.0.5:3443 (LAN IP + default allowed port)', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    assert.equal(await decide(corsOriginCallback, 'https://10.0.0.5:3443'), true);
  });

  it('rejects http://8.8.8.8:3080 (public IP, even on allowed port)', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    assert.equal(await decide(corsOriginCallback, 'http://8.8.8.8:3080'), false);
  });

  it('rejects LAN origins when CORS_ALLOW_LAN is not set', async () => {
    const { corsOriginCallback } = await loadCors({});
    assert.equal(await decide(corsOriginCallback, 'http://192.168.1.10:3080'), false);
  });

  it('honors custom LAN_ALLOWED_PORTS override', async () => {
    const { corsOriginCallback } = await loadCors({
      allowLan: 'true',
      lanAllowedPorts: '4000,4443',
    });
    assert.equal(await decide(corsOriginCallback, 'http://192.168.1.10:4000'), true);
    assert.equal(await decide(corsOriginCallback, 'http://192.168.1.10:3080'), false);
  });

  it('rejects RFC-1918 hostname on default http port 80 when 80 not allowed', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    // no explicit port → default 80, which is NOT in default whitelist (3080, 3443)
    assert.equal(await decide(corsOriginCallback, 'http://192.168.1.10'), false);
  });

  it('rejects 172.15.x.x (outside RFC-1918 172.16-31 range)', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    assert.equal(await decide(corsOriginCallback, 'http://172.15.1.1:3080'), false);
  });

  it('accepts 172.20.x.x (inside RFC-1918 range)', async () => {
    const { corsOriginCallback } = await loadCors({ allowLan: 'true' });
    assert.equal(await decide(corsOriginCallback, 'http://172.20.1.1:3080'), true);
  });
});
