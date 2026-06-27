const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { SignJWT, exportJWK, generateKeyPair } = require('jose');

const app = express();
app.use(express.urlencoded({ extended: true }));

const {
  PORT = 3000,
  BRIDGE_URL,
  NAF_BASE_URL,
  NAF_CLIENT_ID,
  NAF_CLIENT_SECRET,
  NAF_REDIRECT_URI,
  KC_URL,
  KC_PUBLIC_URL,
  KC_REALM,
  KC_ADMIN_CLIENT_ID,
  KC_ADMIN_CLIENT_SECRET,
} = process.env;

// Chiave RSA per firmare i JWT OIDC — generata all'avvio
let privateKey, publicJwk;
(async () => {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair('RS256');
  privateKey = priv;
  publicJwk = { ...(await exportJWK(pub)), use: 'sig', alg: 'RS256', kid: 'naf-bridge-1' };
  console.log('Chiave RSA generata');
})();

// Mappa stati pendenti — TTL 10 minuti
// Tipi:
//   link_<hex>  → { type:'link', keycloakUserId }
//   oidc_<hex>  → { type:'oidc', kcRedirectUri, kcState, kcNonce }
//   code_<hex>  → { type:'code', nafId, nafName, kcNonce }  (auth code OIDC)
const pending = new Map();
const TTL = 10 * 60 * 1000;

function storeState(prefix, data) {
  const key = `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
  pending.set(key, { ...data, ts: Date.now() });
  return key;
}

function consumeState(key) {
  const entry = pending.get(key);
  if (!entry) return null;
  pending.delete(key);
  if (Date.now() - entry.ts > TTL) return null;
  return entry;
}

// ─── Helpers Keycloak ────────────────────────────────────────────────────────

async function getAdminToken() {
  const res = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KC_ADMIN_CLIENT_ID,
      client_secret: KC_ADMIN_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Admin token error: ${res.status}`);
  return (await res.json()).access_token;
}

async function updateKeycloakUser(userId, nafId, nafName) {
  const token = await getAdminToken();
  const getRes = await fetch(`${KC_URL}/admin/realms/${KC_REALM}/users/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) throw new Error(`KC get user error: ${getRes.status}`);
  const user = await getRes.json();
  const putRes = await fetch(`${KC_URL}/admin/realms/${KC_REALM}/users/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...user,
      attributes: {
        ...user.attributes,
        naf_id: [String(nafId)],
        naf_name: [nafName],
        naf_verified: ['true'],
      },
    }),
  });
  if (!putRes.ok) throw new Error(`KC update error: ${putRes.status}`);
}

async function introspectToken(accessToken) {
  const res = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token/introspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: accessToken,
      client_id: KC_ADMIN_CLIENT_ID,
      client_secret: KC_ADMIN_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Introspect error: ${res.status}`);
  const data = await res.json();
  if (!data.active) throw new Error('Token non attivo');
  return data.sub;
}

// ─── Helper NAF ──────────────────────────────────────────────────────────────

async function nafExchangeCode(code) {
  const tokenRes = await fetch(`${NAF_BASE_URL}/index.php?module=NAF&type=token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: NAF_REDIRECT_URI,
      client_id: NAF_CLIENT_ID,
      client_secret: NAF_CLIENT_SECRET,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Token NAF error: ${tokenRes.status}`);
  const tokenData = await tokenRes.json();

  const userRes = await fetch(`${NAF_BASE_URL}/index.php?module=NAF&type=oauthendpoint`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) throw new Error(`User NAF error: ${userRes.status}`);
  return await userRes.json(); // { id, name }
}

// ─── Flusso 1: Collega account NAF (utente già loggato su KC) ────────────────

app.get('/naf/link', (req, res) => {
  const state = storeState('oidc', { ts: Date.now() }); // riuso prefisso oidc per KC
  const params = new URLSearchParams({
    client_id: KC_ADMIN_CLIENT_ID,
    redirect_uri: `${BRIDGE_URL}/naf/link/callback`,
    response_type: 'code',
    scope: 'openid',
    state,
  });
  res.redirect(`${KC_PUBLIC_URL}/realms/${KC_REALM}/protocol/openid-connect/auth?${params}`);
});

app.get('/naf/link/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Errore login Keycloak: ${error}`);
  if (!code || !state) return res.status(400).send('Parametri mancanti');

  const entry = consumeState(state);
  if (!entry) return res.status(400).send('State non valido o scaduto');

  try {
    const tokenRes = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${BRIDGE_URL}/naf/link/callback`,
        client_id: KC_ADMIN_CLIENT_ID,
        client_secret: KC_ADMIN_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token OIDC error: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();

    const keycloakUserId = await introspectToken(tokenData.access_token);
    const nafState = storeState('link', { type: 'link', keycloakUserId });

    const nafParams = new URLSearchParams({
      client_id: NAF_CLIENT_ID,
      redirect_uri: NAF_REDIRECT_URI,
      response_type: 'code',
      state: nafState,
    });
    res.redirect(`${NAF_BASE_URL}/index.php?module=NAF&type=oauth&${nafParams}`);
  } catch (err) {
    console.error('Errore /naf/link/callback:', err.message);
    res.status(500).send('Errore interno');
  }
});

// ─── Flusso 2: Login/registrazione via NAF (proxy OIDC per Keycloak IdP) ─────

// Discovery document OIDC
app.get('/.well-known/openid-configuration', (_, res) => {
  res.json({
    issuer: BRIDGE_URL,
    authorization_endpoint: `${BRIDGE_URL}/naf/oidc/auth`,
    token_endpoint: `${BRIDGE_URL}/naf/oidc/token`,
    userinfo_endpoint: `${BRIDGE_URL}/naf/oidc/userinfo`,
    jwks_uri: `${BRIDGE_URL}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid'],
  });
});

// JWKS — chiave pubblica per verifica JWT
app.get('/jwks', (_, res) => {
  res.json({ keys: [publicJwk] });
});

// Keycloak avvia il flusso NAF login
app.get('/naf/oidc/auth', (req, res) => {
  const { redirect_uri, state, nonce } = req.query;
  if (!redirect_uri) return res.status(400).send('redirect_uri mancante');

  const nafState = storeState('nafoidc', { type: 'nafoidc', kcRedirectUri: redirect_uri, kcState: state, kcNonce: nonce });

  const params = new URLSearchParams({
    client_id: NAF_CLIENT_ID,
    redirect_uri: NAF_REDIRECT_URI,
    response_type: 'code',
    state: nafState,
  });
  res.redirect(`${NAF_BASE_URL}/index.php?module=NAF&type=oauth&${params}`);
});

// Keycloak scambia il code per un JWT id_token
app.post('/naf/oidc/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'invalid_request' });

  const entry = consumeState(code);
  if (!entry || entry.type !== 'authcode') {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      sub: String(entry.nafId),
      name: entry.nafName,
      naf_id: String(entry.nafId),
      naf_name: entry.nafName,
      naf_verified: 'true',
      ...(entry.kcNonce ? { nonce: entry.kcNonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'naf-bridge-1' })
      .setIssuer(BRIDGE_URL)
      .setAudience(KC_ADMIN_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime('1h')
      .sign(privateKey);

    res.json({
      access_token: crypto.randomBytes(16).toString('hex'),
      token_type: 'Bearer',
      id_token: idToken,
      expires_in: 3600,
    });
  } catch (err) {
    console.error('Errore /naf/oidc/token:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Userinfo endpoint (richiesto da Keycloak dopo il token)
app.get('/naf/oidc/userinfo', (req, res) => {
  res.status(401).json({ error: 'not_supported' });
});

// ─── Callback NAF unificata ───────────────────────────────────────────────────
// Gestisce sia il flusso "collega account" (state prefisso link_)
// che il flusso "login OIDC" (state prefisso nafoidc_)

app.get('/naf/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Errore callback NAF:', error);
    return res.redirect('https://forum.tilea.net/my/preferences/account?naf_error=access_denied');
  }
  if (!code || !state) return res.status(400).send('Parametri mancanti');

  const entry = consumeState(state);
  if (!entry) return res.status(400).send('State non valido o scaduto');

  try {
    const nafUser = await nafExchangeCode(code);

    if (entry.type === 'link') {
      // Flusso collegamento account
      await updateKeycloakUser(entry.keycloakUserId, nafUser.id, nafUser.name);
      console.log(`NAF collegato: KC user ${entry.keycloakUserId} → NAF #${nafUser.id} (${nafUser.name})`);
      return res.redirect('https://forum.tilea.net/my/preferences/account?naf_linked=true');
    }

    if (entry.type === 'nafoidc') {
      // Flusso login OIDC — crea un auth code temporaneo per il token endpoint
      const authCode = storeState('authcode', {
        type: 'authcode',
        nafId: nafUser.id,
        nafName: nafUser.name,
        kcNonce: entry.kcNonce,
      });

      const params = new URLSearchParams({ code: authCode });
      if (entry.kcState) params.set('state', entry.kcState);
      return res.redirect(`${entry.kcRedirectUri}?${params}`);
    }

    res.status(400).send('Tipo di stato non riconosciuto');
  } catch (err) {
    console.error('Errore /naf/callback:', err.message);
    res.redirect('https://forum.tilea.net/my/preferences/account?naf_error=server_error');
  }
});

// ─── Legacy endpoint (non più usato ma manteniamo per compatibilità) ──────────
app.get('/naf/start', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Token mancante');
  try {
    const keycloakUserId = await introspectToken(token);
    const nafState = storeState('link', { type: 'link', keycloakUserId });
    const params = new URLSearchParams({
      client_id: NAF_CLIENT_ID,
      redirect_uri: NAF_REDIRECT_URI,
      response_type: 'code',
      state: nafState,
    });
    res.redirect(`${NAF_BASE_URL}/index.php?module=NAF&type=oauth&${params}`);
  } catch (err) {
    console.error('Errore /naf/start:', err.message);
    res.status(401).send('Token Keycloak non valido');
  }
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`NAF bridge in ascolto su porta ${PORT}`));
