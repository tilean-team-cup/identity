# identity — Tilea.net Identity Stack

Stack di autenticazione per [tilea.net](https://tilea.net) basato su Keycloak,
con integrazione NAF OAuth2 e Discourse SSO.

## Architettura

```
Utente browser
  │
  ├── https://forum.tilea.net      →  Discourse (VM separata)
  ├── https://id.tilea.net         →  Keycloak :8080
  └── https://naf-bridge.tilea.net →  NAF Bridge :3000
       (tutti via Cloudflare Tunnel)

Keycloak — Realm: tilea
  ├── Client: discourse   (OIDC per forum.tilea.net)
  └── Client: naf-bridge  (service account + OIDC per /naf/link)

NAF Bridge
  └── OAuth2 Authorization Code verso member.thenaf.net
      → scrive naf_id / naf_name / naf_verified su profilo Keycloak
```

---

## Flusso 1 — Login / Registrazione sul forum

```
Utente clicca "Accedi" su forum.tilea.net
  → Discourse redirige su id.tilea.net (Keycloak OIDC)
  → Utente si autentica (o si registra) su Keycloak
  → Keycloak rimanda a Discourse con token OIDC
  → Discourse crea/aggiorna l'utente locale con i claim ricevuti
    (email, username, naf_id, naf_name, naf_verified)
```

**Configurazione Discourse** (Admin → Settings → Login):
- `enable local logins` → disabilitato
- `enable local logins via email` → disabilitato
- OpenID Connect discovery document: `https://id.tilea.net/realms/tilea/.well-known/openid-configuration`
- Client ID: `discourse`

---

## Flusso 2 — Collegamento account NAF

```
Utente clicca "Collega account NAF" (link a naf-bridge.tilea.net/naf/link)
  → Bridge redirige su Keycloak per autenticarsi (OIDC)
  → Keycloak rimanda al bridge con code OIDC
  → Bridge scambia il code per un access token Keycloak
  → Bridge redirige su member.thenaf.net (NAF OAuth2)
  → Utente autorizza su NAF
  → NAF redirige su forum.tilea.net/auth/oauth2_basic/callback
  → Cloudflare Worker intercetta e redirige su naf-bridge.tilea.net/naf/callback
  → Bridge scambia il code NAF per un access token NAF
  → Bridge chiama /index.php?module=NAF&type=oauthendpoint → ottiene { id, name }
  → Bridge aggiorna il profilo Keycloak: naf_id, naf_name, naf_verified=true
  → Bridge redirige l'utente su id.tilea.net/realms/tilea/account
```

**Cloudflare Worker** (su forum.tilea.net):
```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/auth/oauth2_basic/callback') {
      const bridgeUrl = new URL('https://naf-bridge.tilea.net/naf/callback');
      bridgeUrl.search = url.search;
      return Response.redirect(bridgeUrl.toString(), 302);
    }
    return fetch(request);
  }
};
```
Route: `forum.tilea.net/auth/oauth2_basic/callback*`

---

## Attributi utente NAF

| Attributo      | Descrizione                     | Modificabile da |
|----------------|---------------------------------|-----------------|
| `naf_id`       | Numero NAF (es. "12345")        | Solo admin      |
| `naf_name`     | Nome coach su NAF               | Solo admin      |
| `naf_verified` | `"true"` se collegato via OAuth2 | Solo admin     |

Propagati a Discourse come OIDC claims ad ogni login.

---

## Primo avvio

```bash
git clone https://github.com/tilean-team-cup/identity.git
cd identity

cp .env.example .env
# Compilare .env con tutti i valori reali

docker compose up -d postgres keycloak cloudflared
docker compose logs -f keycloak
# Attendere: "Keycloak 26.x.x on JVM started"

# Dopo il primo avvio, creare l'utente admin permanente dall'interfaccia Keycloak
# poi avviare il bridge:
docker compose up -d --build bridge
```

---

## Cloudflare Tunnel

Un singolo tunnel gestisce due hostname:

| Dominio pubblico              | Servizio interno       |
|-------------------------------|------------------------|
| `id.tilea.net`                | `http://keycloak:8080` |
| `naf-bridge.tilea.net`        | `http://naf-bridge:3000` |

Il token del tunnel va in `CLOUDFLARE_TUNNEL_TOKEN` nel `.env`.

---

## Struttura repo

```
identity/
├── docker-compose.yml
├── .env.example
├── keycloak/
│   ├── imports/
│   │   └── tilea-realm.json   ← realm importato all'avvio (non committare con secret reali)
│   └── themes/                ← tema custom Keycloak (futuro)
└── bridge/
    ├── index.js               ← NAF bridge service
    ├── package.json
    └── Dockerfile
```

---

## Note sicurezza

- `.env` è in `.gitignore` — non verrà mai committato
- I secret nel `tilea-realm.json` (`CAMBIA_QUESTO_SECRET_*`) vanno aggiornati
  manualmente dalla UI Keycloak dopo il primo avvio (Clients → naf-bridge / discourse → Credentials)
- Keycloak e Bridge ascoltano solo su `127.0.0.1` — non esposti direttamente
- Il bridge usa `state` con TTL 10 minuti per prevenire CSRF
