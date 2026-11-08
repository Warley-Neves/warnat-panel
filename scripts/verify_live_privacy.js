const https = require('https');

function request(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, text: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function verifyLive() {
  console.log('--- 1. Testando HTML do Painel em Produção ---');
  const page = await request('https://warnat-panel.onrender.com/');
  console.log('HTML status:', page.status);
  console.log('Possui #privacyConsentGateModal:', page.text ? page.text.includes('privacyConsentGateModal') : false);
  console.log('Possui #privacyPolicyViewModal:', page.text ? page.text.includes('privacyPolicyViewModal') : false);
  console.log('Possui #regTermsConsent:', page.text ? page.text.includes('regTermsConsent') : false);
  console.log('Possui getPrivacyPolicyHtml:', page.text ? page.text.includes('getPrivacyPolicyHtml') : false);

  console.log('\n--- 2. Testando Rota Pública de Privacidade ---');
  const pol = await request('https://warnat-panel.onrender.com/api/v2/privacy-policy');
  console.log('Policy Status:', pol.status, JSON.stringify(pol.data));

  console.log('\n--- 3. Testando Login e Checagem do Gate em Produção ---');
  const loginRes = await request('https://warnat-panel.onrender.com/api/v2/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: 'admin@warnattech.com.br', password: 'WarnatAdmin2026!' });
  console.log('Login Status:', loginRes.status, 'User:', loginRes.data?.user?.email, 'PolicyAccepted:', loginRes.data?.user?.privacyPolicyAccepted);

  const token = loginRes.data?.token;
  if (token) {
    console.log('\n--- 4. Testando /api/v2/auth/me ---');
    const meRes = await request('https://warnat-panel.onrender.com/api/v2/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    console.log('Auth Me Status:', meRes.status, 'privacyPolicyAccepted:', meRes.data?.user?.privacyPolicyAccepted);

    console.log('\n--- 5. Testando Envio de Consentimento (POST /api/v2/auth/consent) ---');
    const consentRes = await request('https://warnat-panel.onrender.com/api/v2/auth/consent', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'AntigravityLiveVerification/1.0'
      }
    }, { version: 'v1.0' });
    console.log('Consent Res Status:', consentRes.status, JSON.stringify(consentRes.data));

    console.log('\n--- 6. Re-checando /api/v2/auth/me após Consentimento ---');
    const meRes2 = await request('https://warnat-panel.onrender.com/api/v2/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    console.log('Auth Me Status Pós-Consent:', meRes2.status, 'privacyPolicyAccepted:', meRes2.data?.user?.privacyPolicyAccepted, 'acceptedAt:', meRes2.data?.user?.privacy_policy_accepted_at);
  }
}

verifyLive().catch(console.error);
