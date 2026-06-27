# identity — Tilea.net Identity Stack

Stack di autenticazione per [tilea.net](https://tilea.net) basato su Keycloak,
con integrazione NAF OAuth2 e Discourse SSO.

## Architettura

```
Cloudflare Tunnel
  ├── keycloak.tilea.net  →  Keycloak :8080
  └── keycloak.tilea.net/naf/*  →  NAF Bridge :3000

Keycloak
  ├── Realm: tilea
  ├── Client: discourse  (OIDC → forum.tilea.net)
  └── Client: naf-bridge (service account)

NAF Bridge
  └── OAuth2 Authorization Code verso member.thenaf.net
      → scrive naf_id / naf_name / naf_verified su Keycloak
```

## Roadmap

- [x] Passo 1 — Keycloak + Postgres (questo repo)
- [ ] Passo 2 — Configurazione Discourse OIDC
- [ ] Passo 3 — NAF Bridge service
- [ ] Passo 4 — Collegamento profilo NAF in Keycloak
- [ ] Passo 5 — Bollino NAF verificato su Discourse

## Primo avvio

```bash
git clone https://github.com/tilean-team-cup/identity.git
cd identity

cp .env.example .env
# Compilare .env con le password reali e i dati NAF OAuth2

docker compose up -d postgres
docker compose up -d keycloak

# Verificare avvio:
docker compose logs -f keycloak
# Cercare: "Keycloak 26.x.x on JVM started"
```

## Cloudflare Tunnel

Nel dashboard → Zero Trust → Tunnels, aggiungere:

| Dominio pubblico              | Servizio interno        |
|-------------------------------|-------------------------|
| `keycloak.tilea.net`          | `http://localhost:8080` |
| `keycloak.tilea.net/naf/*`    | `http://localhost:3000` |

## Attributi utente NAF

| Attributo      | Descrizione                  | Modificabile da |
|----------------|------------------------------|-----------------|
| `naf_id`       | Numero NAF (es. "12345")     | Solo admin      |
| `naf_name`     | Nome coach su NAF            | Solo admin      |
| `naf_verified` | "true" se verificato via OAuth2 | Solo admin   |

Questi attributi vengono propagati a Discourse come OIDC claims ad ogni login.

## Struttura repo

```
identity/
├── docker-compose.yml
├── .env.example
├── keycloak/
│   ├── imports/
│   │   └── tilea-realm.json   ← realm importato all'avvio
│   └── themes/                ← tema custom (passo 4)
└── bridge/                    ← NAF bridge service (passo 3)
```

## Note sicurezza

- `.env` è in `.gitignore` — non verrà mai committato
- I secret nel `tilea-realm.json` (`CAMBIA_QUESTO_SECRET_*`) vanno
  rigenerati dalla UI Keycloak dopo il primo avvio
- Keycloak e Bridge ascoltano solo su `127.0.0.1` — non esposti direttamente
