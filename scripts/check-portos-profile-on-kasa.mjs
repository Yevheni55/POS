const PIN = process.env.KASA_PIN || '9012';
const BASE = process.env.KASA_BASE || 'http://localhost:3080';

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  });
  if (!loginRes.ok) {
    throw new Error(`login ${loginRes.status}: ${await loginRes.text()}`);
  }
  const { token } = await loginRes.json();

  const profileRes = await fetch(`${BASE}/api/company-profile?refresh=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const profile = await profileRes.json();

  const compareRes = await fetch(`${BASE}/api/company-profile/portos-compare`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const compare = await compareRes.json();

  console.log('\n=== company-profile (after refresh) ===');
  console.log(JSON.stringify(profile, null, 2));
  console.log('\n=== portos-compare.summary ===');
  console.log(JSON.stringify(compare.summary, null, 2));
  console.log('\n=== portos side ===');
  console.log(JSON.stringify(compare.portos, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
