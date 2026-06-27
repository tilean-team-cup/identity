const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();

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

// state -> { keycloakUserId, nonce } — in-memory, TTL 10 minuti
const pendingStates = new Map();

function generateState(keycloakUserId) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { keycloakUserId, ts: Date.now() });
  return state;
}

function consumeState(state) {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (Date.now() - entry.ts > 10 * 60 * 1000) return null; // scaduto
  return entry.keycloakUserId;
}

// Ottieni access token admin Keycloak via client_credentials
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
  const data = await res.json();
  return data.access_token;
}

// Aggiorna attributi utente Keycloak preservando i dati esistenti
async function updateKeycloakUser(userId, nafId, nafName) {
  const token = await getAdminToken();

  // Legge il profilo esistente
  const getRes = await fetch(`${KC_URL}/admin/realms/${KC_REALM}/users/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) throw new Error(`Keycloak get user error: ${getRes.status}`);
  const user = await getRes.json();

  // Merge degli attributi NAF sul profilo esistente
  const updatedUser = {
    ...user,
    attributes: {
      ...user.attributes,
      naf_id: [String(nafId)],
      naf_name: [nafName],
      naf_verified: ['true'],
    },
  };

  const putRes = await fetch(`${KC_URL}/admin/realms/${KC_REALM}/users/${userId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(updatedUser),
  });
  if (!putRes.ok) throw new Error(`Keycloak update error: ${putRes.status}`);
}

// Verifica token Keycloak e restituisce il subject (user ID)
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
  return data.sub; // Keycloak user ID
}

// GET /naf/start?token=<keycloak_access_token>
// Avvia il flusso OAuth2 NAF per l'utente autenticato
app.get('/naf/start', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Token mancante');

  try {
    const keycloakUserId = await introspectToken(token);
    const state = generateState(keycloakUserId);

    const params = new URLSearchParams({
      client_id: NAF_CLIENT_ID,
      redirect_uri: NAF_REDIRECT_URI,
      response_type: 'code',
      state,
    });

    res.redirect(`${NAF_BASE_URL}/index.php?module=NAF&type=oauth&${params}`);
  } catch (err) {
    console.error('Errore /naf/start:', err.message);
    res.status(401).send('Token Keycloak non valido');
  }
});

// GET /naf/callback?code=...&state=...
// Callback NAF: scambia code → token → user info → aggiorna Keycloak
app.get('/naf/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Errore callback NAF:', error);
    return res.redirect(`https://id.tilea.net/realms/${KC_REALM}/account?naf_error=access_denied`);
  }

  if (!code || !state) return res.status(400).send('Parametri mancanti');

  const keycloakUserId = consumeState(state);
  if (!keycloakUserId) return res.status(400).send('State non valido o scaduto');

  try {
    // Scambia code per access token
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

    // Recupera identità NAF
    const userRes = await fetch(`${NAF_BASE_URL}/index.php?module=NAF&type=oauthendpoint`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) throw new Error(`User NAF error: ${userRes.status}`);
    const nafUser = await userRes.json(); // { id, name }

    // Aggiorna profilo Keycloak
    await updateKeycloakUser(keycloakUserId, nafUser.id, nafUser.name);

    console.log(`NAF collegato: KC user ${keycloakUserId} → NAF #${nafUser.id} (${nafUser.name})`);
    res.redirect(`https://id.tilea.net/realms/${KC_REALM}/account?naf_linked=true`);
  } catch (err) {
    console.error('Errore /naf/callback:', err.message);
    res.redirect(`https://id.tilea.net/realms/${KC_REALM}/account?naf_error=server_error`);
  }
});

// GET /naf/link
// Avvia il flusso OIDC Keycloak per autenticare l'utente, poi lo manda su NAF
app.get('/naf/link', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(`oidc_${state}`, { ts: Date.now() });

  const params = new URLSearchParams({
    client_id: KC_ADMIN_CLIENT_ID,
    redirect_uri: `${BRIDGE_URL}/naf/link/callback`,
    response_type: 'code',
    scope: 'openid',
    state,
  });

  res.redirect(`${KC_PUBLIC_URL}/realms/${KC_REALM}/protocol/openid-connect/auth?${params}`);
});

// GET /naf/link/callback
// Riceve il code OIDC da Keycloak, lo scambia per un token, avvia il flusso NAF
app.get('/naf/link/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Errore login Keycloak: ${error}`);
  if (!code || !state) return res.status(400).send('Parametri mancanti');

  const entry = pendingStates.get(`oidc_${state}`);
  if (!entry || Date.now() - entry.ts > 10 * 60 * 1000) {
    return res.status(400).send('State non valido o scaduto');
  }
  pendingStates.delete(`oidc_${state}`);

  try {
    // Scambia code OIDC per access token
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

    // Ora abbiamo il token utente, avviamo il flusso NAF
    const keycloakUserId = await introspectToken(tokenData.access_token);
    const nafState = generateState(keycloakUserId);

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

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`NAF bridge in ascolto su porta ${PORT}`));
