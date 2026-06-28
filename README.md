# Tilea Identity Stack

Stack di identità per tilea.net — Blood Bowl community italiana.

## Architettura

```
Utente
  │
  ├─── forum.tilea.net (Discourse)
  │         │ OIDC (discourse-openid-connect)
  │         ▼
  │    id.tilea.net (Keycloak 26.2)
  │         │
  │         ├─── IdP: NAF Bridge (per login/registrazione via NAF)
  │         │         │ OIDC proxy
  │         │         ▼
  │         │    naf-bridge.tilea.net
  │         │         │ OAuth2
  │         │         ▼
  │         │    member.thenaf.net (NAF)
  │         │
  │         └─── Admin API ◄─── naf-bridge (per aggiornare attributi utente)
  │
  └─── naf-bridge.tilea.net/naf/link (per collegare account NAF esistente)
```

## Componenti

### Keycloak (`keycloak/`)

Identity provider centrale su `id.tilea.net`.

- **Versione:** 26.2
- **Database:** PostgreSQL 16
- **Realm:** `tilea`
- **Import automatico** al primo avvio da `keycloak/imports/tilea-realm.json`

#### Client configurati

| Client | Tipo | Scopo |
|--------|------|-------|
| `discourse` | OIDC, Standard Flow | Login/registrazione forum |
| `naf-bridge` | OIDC, Service Account + Standard Flow | Bridge NAF (admin API + link account) |

#### Attributi utente custom

| Attributo | Tipo | Chi può modificare | Descrizione |
|-----------|------|-------------------|-------------|
| `naf_id` | String | Admin only | ID numerico NAF coach |
| `naf_name` | String | Admin only | Nome coach su NAF |
| `naf_verified` | String (`"true"`) | Admin only | Account NAF verificato |

#### Protocol mapper (client `discourse`)

I tre attributi vengono inclusi nel token OIDC inviato a Discourse:
- `naf_id` → claim `naf_id`
- `naf_name` → claim `naf_name`
- `naf_verified` → claim `naf_verified`

#### Identity Provider: NAF Bridge

Configurato su Keycloak come OIDC IdP che punta al bridge:
- **Discovery URL:** `https://naf-bridge.tilea.net/.well-known/openid-configuration`
- **Token endpoint override:** `http://naf-bridge:3000/naf/oidc/token` (rete Docker interna)
- **First Login Flow:** `first broker login`
- **Hide on Login Page:** No (visibile sia su login che registrazione)
- **Mapper `Username Template Importer`:** usa `${CLAIM.preferred_username}` come username

#### Mapper IdP NAF

| Nome | Tipo | Claim | Attributo KC | Sync Mode |
|------|------|-------|--------------|-----------|
| `NAF ID` | Attribute Importer | `naf_id` | `naf_id` | Force |
| `NAF Name` | Attribute Importer | `naf_name` | `naf_name` | Force |
| `NAF Verified` | Attribute Importer | `naf_verified` | `naf_verified` | Force |

#### Localizzazione

- Lingua default: Italiano (`it`)
- Label pulsante IdP NAF: configurabile via Admin → Realm settings → Localization → Italian → chiave `identity-provider-login-label`

---

### NAF Bridge (`bridge/`)

Servizio Node.js/Express su `naf-bridge.tilea.net`. NAF espone OAuth2 (Authorization Code), non OIDC. Il bridge traduce il flusso NAF in OIDC standard che Keycloak sa consumare, e gestisce anche il collegamento account per utenti già registrati.

#### Chiave RSA

Il bridge firma i JWT con RS256. La chiave è persistente tramite `BRIDGE_PRIVATE_KEY` / `BRIDGE_PUBLIC_KEY` nel `.env`. Se le variabili mancano, genera una chiave temporanea che viene persa al riavvio (Keycloak fallirà la validazione del JWT).

Per generare una nuova coppia:
```bash
node -e "
const {generateKeyPairSync} = require('crypto');
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
console.log('BRIDGE_PRIVATE_KEY=' + JSON.stringify(privateKey.export({type:'pkcs8',format:'pem'})));
console.log('BRIDGE_PUBLIC_KEY=' + JSON.stringify(publicKey.export({type:'spki',format:'pem'})));
"
```

#### Endpoint

| Endpoint | Metodo | Descrizione |
|----------|--------|-------------|
| `/.well-known/openid-configuration` | GET | Discovery document OIDC |
| `/jwks` | GET | Chiave pubblica RSA per verifica JWT |
| `/naf/oidc/auth` | GET | Auth endpoint OIDC (Keycloak avvia il flusso NAF) |
| `/naf/oidc/token` | POST | Token endpoint OIDC (Keycloak scambia il code per JWT) |
| `/naf/oidc/userinfo` | GET | Userinfo endpoint OIDC |
| `/naf/link` | GET | Avvia flusso collegamento account NAF |
| `/naf/link/callback` | GET | Callback dopo login KC nel flusso di link |
| `/naf/callback` | GET | Callback NAF unificata (link + login OIDC) |
| `/health` | GET | Health check |

#### Gestione stati

Il bridge usa una mappa in memoria con TTL 10 minuti per tenere traccia dei flussi in corso. Le chiavi hanno un prefisso che identifica il tipo:

| Prefisso | Tipo flusso | Dati |
|----------|------------|------|
| `oidc_` | KC auth per link | `{ ts }` |
| `link_` | Collegamento account | `{ type:'link', keycloakUserId }` |
| `nafoidc_` | Login OIDC via NAF | `{ type:'nafoidc', kcRedirectUri, kcState, kcNonce }` |
| `authcode_` | Auth code temporaneo per KC | `{ type:'authcode', nafId, nafName, kcNonce }` |
| `access_` | Access token userinfo | `{ nafId, nafName }` |

---

## Flussi

### Flusso 1 — Login/registrazione via NAF

Utente clicca "Registrati con un account NAF esistente" sulla login/registrazione Keycloak.

```
Utente clicca "Registrati con NAF" su Keycloak
  │
  ▼
Keycloak → GET /naf/oidc/auth?redirect_uri=...&state=...&nonce=...
  Bridge salva stato nafoidc_{hex} = { kcRedirectUri, kcState, kcNonce }
  │
  ▼
Bridge → redirect a member.thenaf.net/oauth (state=nafoidc_{hex})
  │
  ▼
Utente si autentica su NAF
  │
  ▼
NAF → GET /naf/callback?code=...&state=nafoidc_{hex}
  Bridge scambia il code NAF → access token NAF → { id, name }
  Bridge cerca su KC utente con username = nafName
    → se trovato: include la sua email nel JWT (per matching account esistente)
  Bridge salva stato authcode_{hex} = { type:'authcode', nafId, nafName, kcNonce }
  │
  ▼
Bridge → redirect a kcRedirectUri?code=authcode_{hex}&state=kcState
  │
  ▼
Keycloak → POST /naf/oidc/token (code=authcode_{hex})
  Bridge genera JWT RS256:
    sub=nafId, preferred_username=nafName,
    email (se trovato utente KC esistente),
    naf_id, naf_name, naf_verified="true"
  │
  ▼
Keycloak → GET /naf/oidc/userinfo
  Bridge restituisce { sub, preferred_username, naf_id, naf_name, naf_verified }
  │
  ▼
Keycloak esegue IdP mapper (Attribute Importer, Sync Mode: Force)
  → salva naf_id, naf_name, naf_verified sugli attributi utente KC
  │
  ├─ Utente nuovo → form "Aggiorna informazioni account"
  │    username pre-compilato con nafName, l'utente inserisce email
  │
  └─ Utente esistente (email matchata) → Keycloak chiede conferma collegamento
  │
  ▼
Keycloak → redirect a Discourse con code OIDC
  │
  ▼
Discourse completa il login, sincronizza custom fields NAF al primo login
```

### Flusso 2 — Collegamento account NAF

Utente già registrato clicca "Collega account NAF" nelle preferenze Discourse.

```
Utente clicca "Collega account NAF" (preferences → account)
  Link → https://naf-bridge.tilea.net/naf/link
  │
  ▼
Bridge salva stato oidc_{hex}
Bridge → redirect a id.tilea.net/realms/tilea/protocol/openid-connect/auth
  │ (KC identifica l'utente corrente, usa la sessione se disponibile)
  │
  ▼
Keycloak → GET /naf/link/callback?code=...&state=oidc_{hex}
  Bridge scambia il code KC per access token
  Bridge fa introspect del token → ottiene keycloakUserId
  Bridge salva stato link_{hex} = { type:'link', keycloakUserId }
  │
  ▼
Bridge → redirect a member.thenaf.net/oauth (state=link_{hex})
  │
  ▼
Utente si autentica su NAF
  │
  ▼
NAF → GET /naf/callback?code=...&state=link_{hex}
  Bridge scambia il code NAF → { nafId, nafName }
  Bridge → PUT /admin/realms/tilea/users/{keycloakUserId}
    aggiorna attributi KC: naf_id, naf_name, naf_verified="true"
  │
  ▼
Bridge → redirect a forum.tilea.net/my/preferences/account?naf_linked=true

Al prossimo login Discourse: il token KC include i claim NAF → custom fields sincronizzati
```

### Flusso 3 — Login standard

```
Utente → forum.tilea.net
  Discourse → id.tilea.net (OIDC standard flow)
  Utente inserisce email/password su Keycloak
  Keycloak → Discourse con id_token (include claim NAF se presenti)
  Discourse sincronizza custom fields NAF ad ogni login
```

---

## Integrazione Discourse

### Plugin OIDC (`discourse-openid-connect`)

Impostazioni chiave:

| Setting | Valore |
|---------|--------|
| `openid connect enabled` | ✅ |
| `openid connect discovery document` | `https://id.tilea.net/realms/tilea/.well-known/openid-configuration` |
| `openid connect client id` | `discourse` |
| `openid connect verbose logging` | ✅ (abilitare per debug) |
| `openid connect overrides email` | ✅ |

Il logout reindirizza a `https://forum.tilea.net` tramite `post_logout_redirect_uri` configurato nel client KC `discourse`.

### Sincronizzazione custom fields

I claim OIDC `naf_id`, `naf_name`, `naf_verified` vengono sincronizzati ai custom fields Discourse **ad ogni login**. Alla prima registrazione i campi restano vuoti; si popolano al primo login successivo.

### Theme Component: NAF Badge (`naf-badge/`)

Mostra un badge nei post degli utenti con account NAF verificato.

**File principali:**

- `javascripts/discourse/initializers/naf-badge.js` — aggiunge l'icona con `api.addPosterIcons()`
- `javascripts/discourse/connectors/user-preferences-account-after-email/naf-link.gjs` — pulsante "Collega account NAF" nelle preferenze
- `stylesheets/naf-badge.scss` — stili

**Mapping custom fields:**

| Custom field Discourse | Claim OIDC | Contenuto |
|----------------------|------------|-----------|
| `user_field_1` | `naf_id` | ID numerico NAF |
| `user_field_3` | `naf_verified` | `"true"` se verificato |

Il pulsante "Collega account NAF" è nascosto se `user_field_3 === "true"`.

Il badge mostra emoji `:naf:` (emoji custom da caricare su Discourse) con link a `member.thenaf.net/index.php?module=NAF&type=coachpage&coach={nafId}`.

---

## Deploy

### Requisiti

- Docker + Docker Compose
- Cloudflare Tunnel con hostname:
  - `id.tilea.net` → `http://keycloak:8080`
  - `naf-bridge.tilea.net` → `http://naf-bridge:3000`

### Configurazione

```bash
cp .env.example .env
# Compilare tutte le variabili
```

| Variabile | Descrizione |
|-----------|-------------|
| `POSTGRES_PASSWORD` | Password database PostgreSQL |
| `KC_ADMIN_USER` | Username admin Keycloak (solo primo bootstrap) |
| `KC_ADMIN_PASSWORD` | Password admin Keycloak (solo primo bootstrap) |
| `NAF_CLIENT_ID` | Client ID OAuth2 NAF (da admin NAF) |
| `NAF_CLIENT_SECRET` | Client secret OAuth2 NAF |
| `NAF_REDIRECT_URI` | Callback URL registrata su NAF (`https://forum.tilea.net/auth/oauth2_basic/callback`) |
| `KC_BRIDGE_CLIENT_SECRET` | Secret del client `naf-bridge` su Keycloak |
| `BRIDGE_PRIVATE_KEY` | Chiave privata RSA PKCS8 PEM (con `\n` letterali nel valore) |
| `BRIDGE_PUBLIC_KEY` | Chiave pubblica RSA SPKI PEM (con `\n` letterali nel valore) |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token Cloudflare Tunnel |
| `DISCOURSE_API_KEY` | API key admin Discourse (solo per migrazione utenti) |

### Avvio

```bash
docker compose up -d
```

Al primo avvio Keycloak importa automaticamente il realm da `keycloak/imports/tilea-realm.json`. Le configurazioni manuali (IdP mapper, username mapper, localizzazione) vanno applicate dopo il primo avvio tramite la admin console.

### Aggiornamento bridge

```bash
git pull
docker compose up -d --build bridge
```

---

## Migrazione utenti da Discourse

```bash
source .env && docker run --rm -it \
  --network identity_keycloak-net \
  --env-file .env \
  -e KC_URL=http://keycloak:8080 \
  -e KC_REALM=tilea \
  -e KC_ADMIN_CLIENT_ID=naf-bridge \
  -e KC_ADMIN_CLIENT_SECRET=${KC_BRIDGE_CLIENT_SECRET} \
  -e DISCOURSE_URL=https://forum.tilea.net \
  -e DISCOURSE_API_USER=system \
  -v $(pwd)/migrate-users.js:/app/migrate-users.js \
  node:20-alpine \
  sh -c "cd /app && npm install node-fetch@2 dotenv --silent && node migrate-users.js"
```

Lo script:
1. Legge tutti gli utenti attivi da Discourse (paginazione automatica)
2. Salta `system`, `discobot`, `admin` e chi è già in Keycloak per email o username
3. Crea ogni utente con `emailVerified=true` e `requiredActions: UPDATE_PASSWORD`
4. Invia email di reset password a ogni utente creato

---

## Note operative

- **Attributi NAF su Discourse:** sincronizzati ad ogni login, non alla registrazione. Al primo accesso post-registrazione i campi vengono valorizzati automaticamente.
- **Cloudflare Worker:** intercetta `forum.tilea.net/auth/oauth2_basic/callback` e reindirizza a `naf-bridge.tilea.net/naf/callback`. Necessario perché NAF ha registrato il vecchio URL come redirect_uri e non è modificabile.
- **Rete Docker interna:** Keycloak raggiunge il bridge via `http://naf-bridge:3000` (non via URL pubblico). Configurato nel campo "Token Service URL Override" dell'IdP NAF su Keycloak.
- **Chiave RSA:** se si rigenera la chiave, Keycloak deve ricaricare il JWKS. Andare su Admin → Identity Providers → naf → Edit → Save per forzare il refresh.
