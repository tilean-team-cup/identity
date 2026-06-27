#!/usr/bin/env bash
# =============================================================================
# bootstrap-github.sh
# Inizializza il repo locale, crea la struttura completa e fa push su:
#   https://github.com/tilean-team-cup/identity.git
#
# Uso:
#   chmod +x bootstrap-github.sh
#   ./bootstrap-github.sh
#
# Richiede git configurato con accesso a GitHub (SSH key o token HTTPS).
# Per HTTPS con token:
#   git remote set-url origin https://<TOKEN>@github.com/tilean-team-cup/identity.git
# =============================================================================

set -euo pipefail

REPO_URL="https://github.com/tilean-team-cup/identity.git"
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RESET="\033[0m"

info()  { echo -e "${GREEN}▶ $*${RESET}"; }
warn()  { echo -e "${YELLOW}⚠ $*${RESET}"; }
die()   { echo -e "\033[0;31m✗ $*${RESET}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. Pre-flight checks
# ---------------------------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git non trovato"

info "Inizializzazione repo: $REPO_URL"

# ---------------------------------------------------------------------------
# 1. Git init
# ---------------------------------------------------------------------------
if [ ! -d ".git" ]; then
  git init
  git remote add origin "$REPO_URL"
else
  warn ".git già presente — salto git init"
  # Assicuro che il remote sia corretto
  git remote set-url origin "$REPO_URL" 2>/dev/null || git remote add origin "$REPO_URL"
fi

git checkout -b main 2>/dev/null || git checkout main

# ---------------------------------------------------------------------------
# 2. Struttura directory
# ---------------------------------------------------------------------------
info "Creo struttura directory..."
mkdir -p keycloak/imports
mkdir -p keycloak/themes
mkdir -p bridge

# ---------------------------------------------------------------------------
# 3. .gitignore
# ---------------------------------------------------------------------------
info "Scrivo .gitignore..."
cat > .gitignore << 'EOF'
# Secrets — MAI committare
.env

# Node
bridge/node_modules/
bridge/dist/

# Certificati
*.pem
*.key

# Editor
.DS_Store
.idea/
*.swp
EOF

# ---------------------------------------------------------------------------
# 4. .env.example
# ---------------------------------------------------------------------------
info "Scrivo .env.example..."
cat > .env.example << 'EOF'
# Copiare in .env e compilare prima di avviare — NON committare .env su git

# PostgreSQL
POSTGRES_PASSWORD=cambia_questa_password_sicura

# Keycloak admin (usato solo al primo bootstrap)
KC_ADMIN_USER=admin
KC_ADMIN_PASSWORD=cambia_questa_password_sicura

# NAF OAuth2 — forniti dall'admin NAF
NAF_CLIENT_ID=il_tuo_client_id
NAF_CLIENT_SECRET=il_tuo_client_secret

# Secret del client Keycloak per il bridge
# Generare dalla UI Keycloak dopo il primo avvio (passo 4 del piano)
KC_BRIDGE_CLIENT_SECRET=da_generare_dopo
EOF

# ---------------------------------------------------------------------------
# 5. docker-compose.yml
# ---------------------------------------------------------------------------
info "Scrivo docker-compose.yml..."
cat > docker-compose.yml << 'EOF'
services:

  postgres:
    image: postgres:16-alpine
    container_name: keycloak-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: keycloak
      POSTGRES_USER: keycloak
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - keycloak-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U keycloak"]
      interval: 10s
      timeout: 5s
      retries: 5

  keycloak:
    image: quay.io/keycloak/keycloak:26.2
    container_name: keycloak
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      # Database
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: ${POSTGRES_PASSWORD}
      # Admin bootstrap
      KC_BOOTSTRAP_ADMIN_USERNAME: ${KC_ADMIN_USER}
      KC_BOOTSTRAP_ADMIN_PASSWORD: ${KC_ADMIN_PASSWORD}
      # Hostname — Cloudflare Tunnel termina TLS, KC gira in HTTP interno
      KC_HOSTNAME: https://keycloak.tilea.net
      KC_HOSTNAME_STRICT: "true"
      KC_HTTP_ENABLED: "true"
      KC_PROXY_HEADERS: xforwarded
      KC_LOG_LEVEL: INFO
    command: ["start", "--import-realm"]
    volumes:
      - ./keycloak/imports:/opt/keycloak/data/import:ro
      - ./keycloak/themes:/opt/keycloak/themes:ro
    networks:
      - keycloak-net
    ports:
      - "127.0.0.1:8080:8080"

  bridge:
    build:
      context: ./bridge
      dockerfile: Dockerfile
    container_name: naf-bridge
    restart: unless-stopped
    depends_on:
      - keycloak
    environment:
      PORT: 3000
      NAF_BASE_URL: https://member.thenaf.net
      NAF_CLIENT_ID: ${NAF_CLIENT_ID}
      NAF_CLIENT_SECRET: ${NAF_CLIENT_SECRET}
      NAF_REDIRECT_URI: https://keycloak.tilea.net/naf/callback
      KC_URL: http://keycloak:8080
      KC_REALM: tilea
      KC_ADMIN_CLIENT_ID: naf-bridge
      KC_ADMIN_CLIENT_SECRET: ${KC_BRIDGE_CLIENT_SECRET}
    networks:
      - keycloak-net
    ports:
      - "127.0.0.1:3000:3000"

volumes:
  postgres_data:

networks:
  keycloak-net:
    driver: bridge
EOF

# ---------------------------------------------------------------------------
# 6. Realm import JSON
# ---------------------------------------------------------------------------
info "Scrivo keycloak/imports/tilea-realm.json..."
cat > keycloak/imports/tilea-realm.json << 'EOF'
{
  "realm": "tilea",
  "displayName": "Tilea.net",
  "enabled": true,
  "registrationAllowed": false,
  "resetPasswordAllowed": true,
  "rememberMe": true,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "sslRequired": "external",
  "defaultSignatureAlgorithm": "RS256",

  "userProfileConfig": {
    "attributes": [
      {
        "name": "username",
        "displayName": "${username}",
        "validations": {
          "length": { "min": 3, "max": 255 },
          "username-prohibited-characters": {}
        },
        "permissions": { "view": ["admin","user"], "edit": ["admin","user"] }
      },
      {
        "name": "email",
        "displayName": "${email}",
        "validations": { "email": {}, "length": { "max": 255 } },
        "permissions": { "view": ["admin","user"], "edit": ["admin","user"] }
      },
      {
        "name": "firstName",
        "displayName": "${firstName}",
        "permissions": { "view": ["admin","user"], "edit": ["admin","user"] }
      },
      {
        "name": "lastName",
        "displayName": "${lastName}",
        "permissions": { "view": ["admin","user"], "edit": ["admin","user"] }
      },
      {
        "name": "naf_id",
        "displayName": "NAF Number",
        "annotations": { "inputType": "text" },
        "permissions": {
          "view": ["admin","user"],
          "edit": ["admin"]
        },
        "multivalued": false
      },
      {
        "name": "naf_name",
        "displayName": "NAF Coach Name",
        "annotations": { "inputType": "text" },
        "permissions": {
          "view": ["admin","user"],
          "edit": ["admin"]
        },
        "multivalued": false
      },
      {
        "name": "naf_verified",
        "displayName": "NAF Verified",
        "annotations": { "inputType": "text" },
        "permissions": {
          "view": ["admin","user"],
          "edit": ["admin"]
        },
        "multivalued": false
      }
    ]
  },

  "clients": [
    {
      "clientId": "discourse",
      "name": "Discourse Forum",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": false,
      "secret": "CAMBIA_QUESTO_SECRET_DISCOURSE",
      "redirectUris": [
        "https://forum.tilea.net/auth/oidc/callback"
      ],
      "webOrigins": [
        "https://forum.tilea.net"
      ],
      "attributes": {
        "post.logout.redirect.uris": "https://forum.tilea.net"
      },
      "protocolMappers": [
        {
          "name": "naf_id",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-attribute-mapper",
          "config": {
            "user.attribute": "naf_id",
            "claim.name": "naf_id",
            "jsonType.label": "String",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        },
        {
          "name": "naf_name",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-attribute-mapper",
          "config": {
            "user.attribute": "naf_name",
            "claim.name": "naf_name",
            "jsonType.label": "String",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        },
        {
          "name": "naf_verified",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-attribute-mapper",
          "config": {
            "user.attribute": "naf_verified",
            "claim.name": "naf_verified",
            "jsonType.label": "String",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        }
      ]
    },
    {
      "clientId": "naf-bridge",
      "name": "NAF Bridge Service",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "standardFlowEnabled": false,
      "serviceAccountsEnabled": true,
      "secret": "CAMBIA_QUESTO_SECRET_BRIDGE",
      "redirectUris": [],
      "webOrigins": []
    }
  ],

  "roles": {
    "realm": [
      {
        "name": "naf-member",
        "description": "Utente con profilo NAF verificato"
      },
      {
        "name": "forum-member",
        "description": "Membro del forum Tilea"
      }
    ]
  }
}
EOF

# ---------------------------------------------------------------------------
# 7. Placeholder bridge/ (popolato al passo 3)
# ---------------------------------------------------------------------------
info "Creo placeholder bridge/..."
cat > bridge/.gitkeep << 'EOF'
# Questo file tiene la directory tracciata da git.
# Il codice del bridge verrà aggiunto al passo 3.
EOF

# ---------------------------------------------------------------------------
# 8. Placeholder keycloak/themes/ 
# ---------------------------------------------------------------------------
cat > keycloak/themes/.gitkeep << 'EOF'
# Tema Keycloak custom — aggiunto al passo 4.
EOF

# ---------------------------------------------------------------------------
# 9. README.md
# ---------------------------------------------------------------------------
info "Scrivo README.md..."
cat > README.md << 'EOF'
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
EOF

# ---------------------------------------------------------------------------
# 10. Commit e push
# ---------------------------------------------------------------------------
info "Commit iniziale..."
git add -A
git commit -m "feat: initial Keycloak + Postgres stack (step 1)

- docker-compose.yml: Keycloak 26.2 + Postgres 16 + Bridge placeholder
- keycloak/imports/tilea-realm.json: realm tilea con attributi NAF custom
  (naf_id, naf_name, naf_verified), client discourse + naf-bridge,
  ruoli naf-member e forum-member
- .env.example: template variabili d'ambiente
- README.md: architettura e istruzioni primo avvio"

info "Push su $REPO_URL..."
echo ""
warn "Se richiede autenticazione HTTPS, usa:"
warn "  git remote set-url origin https://<TOKEN>@github.com/tilean-team-cup/identity.git"
warn "e poi ri-esegui:  git push -u origin main"
echo ""

git push -u origin main

echo ""
echo -e "${BOLD}${GREEN}✓ Done! Repo disponibile su:${RESET}"
echo -e "  ${BOLD}https://github.com/tilean-team-cup/identity${RESET}"
echo ""
echo -e "Prossimi passi sul server:"
echo -e "  git clone https://github.com/tilean-team-cup/identity.git"
echo -e "  cd identity"
echo -e "  cp .env.example .env   # e compilare"
echo -e "  docker compose up -d"
