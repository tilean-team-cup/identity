#!/usr/bin/env node
/**
 * Migrazione utenti da Discourse a Keycloak
 *
 * Uso:
 *   node migrate-users.js
 *
 * Variabili d'ambiente richieste (nel .env o esportate):
 *   DISCOURSE_URL        es. https://forum.tilea.net
 *   DISCOURSE_API_KEY    API key admin Discourse
 *   DISCOURSE_API_USER   Username admin Discourse (es. system)
 *   KC_URL               es. http://localhost:8080
 *   KC_REALM             es. tilea
 *   KC_ADMIN_CLIENT_ID   es. naf-bridge
 *   KC_ADMIN_CLIENT_SECRET
 */

require('dotenv').config();
const fetch = require('node-fetch');

const {
  DISCOURSE_URL,
  DISCOURSE_API_KEY,
  DISCOURSE_API_USER = 'system',
  KC_URL,
  KC_REALM,
  KC_ADMIN_CLIENT_ID,
  KC_ADMIN_CLIENT_SECRET,
} = process.env;

// ─── Keycloak ────────────────────────────────────────────────────────────────

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

async function getKeycloakUsers(token) {
  const res = await fetch(`${KC_URL}/admin/realms/${KC_REALM}/users?max=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`KC users error: ${res.status}`);
  return await res.json();
}

async function createKeycloakUser(token, user) {
  const res = await fetch(`${KC_URL}/admin/realms/${KC_REALM}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(user),
  });
  if (res.status === 409) return { skipped: true }; // già esiste
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`KC create user error: ${res.status} — ${body}`);
  }
  return { created: true };
}

async function sendPasswordResetEmail(token, userId) {
  const res = await fetch(
    `${KC_URL}/admin/realms/${KC_REALM}/users/${userId}/execute-actions-email`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(['UPDATE_PASSWORD']),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    console.warn(`  ⚠ Email reset fallita: ${res.status} — ${body}`);
  }
}

async function findKeycloakUserByEmail(token, email) {
  const res = await fetch(
    `${KC_URL}/admin/realms/${KC_REALM}/users?email=${encodeURIComponent(email)}&exact=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const users = await res.json();
  return users[0] || null;
}

// ─── Discourse ───────────────────────────────────────────────────────────────

async function getDiscourseUsers(page = 1) {
  const res = await fetch(
    `${DISCOURSE_URL}/admin/users/list/active.json?page=${page}&show_emails=true`,
    {
      headers: {
        'Api-Key': DISCOURSE_API_KEY,
        'Api-Username': DISCOURSE_API_USER,
      },
    }
  );
  if (!res.ok) throw new Error(`Discourse users error: ${res.status}`);
  return await res.json();
}

async function getAllDiscourseUsers() {
  const users = [];
  let page = 1;
  while (true) {
    const batch = await getDiscourseUsers(page);
    if (!batch || batch.length === 0) break;
    users.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return users;
}

// ─── Migrazione ──────────────────────────────────────────────────────────────

const SKIP_USERNAMES = ['system', 'discobot', 'admin'];

async function migrate() {
  console.log('=== Migrazione utenti Discourse → Keycloak ===\n');

  const token = await getAdminToken();
  console.log('✓ Token admin Keycloak ottenuto');

  const kcUsers = await getKeycloakUsers(token);
  const kcEmails = new Set(kcUsers.map(u => u.email?.toLowerCase()).filter(Boolean));
  const kcUsernames = new Set(kcUsers.map(u => u.username?.toLowerCase()).filter(Boolean));
  console.log(`✓ Utenti già in Keycloak: ${kcUsers.length}`);

  const discourseUsers = await getAllDiscourseUsers();
  console.log(`✓ Utenti Discourse trovati: ${discourseUsers.length}\n`);

  let created = 0, skipped = 0, errors = 0;

  for (const du of discourseUsers) {
    if (SKIP_USERNAMES.includes(du.username?.toLowerCase())) continue;
    if (du.id <= 0) continue;

    const email = du.email?.toLowerCase();
    const username = du.username;

    if (!email || !username) {
      console.log(`  SKIP ${username} — email o username mancante`);
      skipped++;
      continue;
    }

    if (kcEmails.has(email) || kcUsernames.has(username.toLowerCase())) {
      console.log(`  SKIP ${username} <${email}> — già in Keycloak`);
      skipped++;
      continue;
    }

    const kcUser = {
      username,
      email,
      emailVerified: true,
      enabled: true,
      requiredActions: ['UPDATE_PASSWORD'],
    };

    try {
      const result = await createKeycloakUser(token, kcUser);
      if (result.skipped) {
        console.log(`  SKIP ${username} <${email}> — conflitto`);
        skipped++;
      } else {
        // Trova l'utente appena creato per mandare l'email di reset
        const newUser = await findKeycloakUserByEmail(token, email);
        if (newUser) {
          await sendPasswordResetEmail(token, newUser.id);
          console.log(`  ✓ CREATO ${username} <${email}> — email reset inviata`);
        } else {
          console.log(`  ✓ CREATO ${username} <${email}> — email reset NON inviata (utente non trovato)`);
        }
        created++;
      }
    } catch (err) {
      console.error(`  ✗ ERRORE ${username} <${email}>: ${err.message}`);
      errors++;
    }

    // Pausa per non sovraccaricare le API
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n=== Risultato ===`);
  console.log(`  Creati:   ${created}`);
  console.log(`  Saltati:  ${skipped}`);
  console.log(`  Errori:   ${errors}`);
}

migrate().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
