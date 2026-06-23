# GR Tools

API REST construida sobre Cloudflare Workers con documentación OpenAPI 3.1 automática. Expone utilidades internas del Grupo GR, comenzando con parseo de contenido basado en plantillas.

## Stack

- [Cloudflare Workers](https://workers.dev) — runtime serverless en el edge
- [Hono](https://github.com/honojs/hono) — router HTTP
- [chanfana](https://github.com/cloudflare/chanfana) — generación automática de esquema OpenAPI 3.1 y validación de requests
- [Zod](https://zod.dev) — validación de tipos en runtime

## Endpoints

### `POST /api/parse`

Extrae variables de un texto usando una plantilla inversa con marcadores `{variable}`.

**Body:**
```json
{
  "template": "Hola {nombre}, tu pedido {pedido} está listo.",
  "content": "<p>Hola Juan, tu pedido #4521 está listo.</p>",
  "html": true
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `template` | `string` | Plantilla con marcadores `{variable}` |
| `content` | `string` | Contenido del que se extraen los valores |
| `html` | `boolean` | Si `true` (default), limpia tags HTML y entidades antes de parsear |

**Respuesta `200`:**
```json
{
  "nombre": "Juan",
  "pedido": "#4521"
}
```

---

### `POST /api/parse/template`

Igual que `/api/parse` pero en lugar de recibir la plantilla en el body, la obtiene por nombre desde la biblioteca de respuestas enlatadas de Genesys Cloud. El contenido HTML de la respuesta enlatada se sanitiza automáticamente antes de usarse como plantilla.

**Body:**
```json
{
  "name": "Confirmacion de pedido",
  "content": "<p>Hola Juan, tu pedido #4521 está listo.</p>",
  "html": true
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `name` | `string` | Nombre exacto de la respuesta enlatada en Genesys |
| `content` | `string` | Contenido del que se extraen los valores |
| `html` | `boolean` | Si `true` (default), limpia tags HTML y entidades antes de parsear |

**Respuesta `200`:**
```json
{
  "nombre": "Juan",
  "pedido": "#4521"
}
```

**Respuesta `422`** (template no encontrada o contenido no coincide):
```json
{
  "error": "Canned response not found: \"Confirmacion de pedido\""
}
```

---

La documentación Swagger interactiva está disponible en la raíz del Worker (`GET /`).

## Configuración

### Variables de entorno (`wrangler.jsonc`)

| Variable | Descripción |
|---|---|
| `GENESYS_LIBRARY_ID` | ID de la biblioteca de respuestas enlatadas en Genesys Cloud |
| `GENESYS_CLIENT_ID` | Client ID de la aplicación OAuth en Genesys Cloud |

### Secrets (no van en el repositorio)

Configurar con `wrangler secret put <nombre>`:

| Secret | Descripción |
|---|---|
| `GENESYS_CLIENT_SECRET` | Client Secret de la aplicación OAuth en Genesys Cloud |

### Request headers

The Genesys integration accepts two optional request headers that override the configured vars/secrets for a single request:

- `Authorization`: full Authorization header to use for obtaining the Genesys OAuth token (for example `Basic <base64>`). If present, the worker will use this value directly to request a token. If absent, the worker falls back to the configured `GENESYS_CLIENT_ID` + `GENESYS_CLIENT_SECRET`.
- `Genesys-Library-Id`: ID of the Genesys canned responses library. If present, this header value will be used instead of the `GENESYS_LIBRARY_ID` var from configuration.

- `Genesys-Debug`: when set to `true` (case-insensitive) the worker will emit debug logs to Cloudflare logs for the parsing endpoints. Debug logs include:
  - For `POST /api/parse`: the provided `template`, the `content`, and the parsed `result` or error.
  - For `POST /api/parse/template`: the request `content`, the raw Genesys API response, the sanitized `template` used, and the parsed `result` or error.

Provide these headers when calling `POST /api/parse/template` to use per-request credentials or a different library ID, and optionally enable `Genesys-Debug` to capture detailed logs for troubleshooting.

## Template syntax notes

You can use a small template language with placeholders in curly braces:

- `{name}` — captures a named variable.
- `{...}` — matches (and ignores) any text between surrounding parts (non-greedy). This is useful when the canned response contains variable text you don't want to capture.

Example:

Content: "Inicio de contenido, hola Marco hoy es el 12/12/2020 y necesito 1,000 adios"

Template: "hola {name} {...} necesito {amount}"

Result: `{ "name": "Marco", "amount": "1,000" }`

## Desarrollo local

```bash
npm install
wrangler login
wrangler dev
```

Abrir `http://localhost:8787/` para acceder al Swagger UI.

## Deploy

```bash
wrangler deploy
```

El Worker se crea automáticamente en Cloudflare si no existe.
