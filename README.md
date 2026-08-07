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

Es el endpoint genérico: **si `content` es un array JSON de adjuntos, se trata como tal** — se descarga el primer PDF y se parsea su texto. Esto permite que un llamador con un solo campo de string (un Data Action de Genesys, por ejemplo) mande cualquiera de las dos cosas.

**Body:**
```json
{
  "name": "Confirmacion de pedido",
  "content": "<p>Hola Juan, tu pedido #4521 está listo.</p>",
  "html": true
}
```

Con adjuntos, el mismo campo `content`:
```json
{
  "name": "Reporte de siniestro",
  "content": "[{\"contentLength\":45991,\"contentType\":\"application/pdf\",\"contentUri\":\"https://...\",\"id\":\"19f9b9824f148d185ad3\",\"name\":\"103967-2026.pdf\"}]"
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `name` | `string` | Nombre exacto de la respuesta enlatada en Genesys |
| `content` | `string` | Contenido del que se extraen los valores, o el array JSON de adjuntos |
| `html` | `boolean` | Si `true` (default), limpia tags HTML y entidades antes de parsear. Se ignora cuando el contenido salió de un PDF: ese texto ya es plano y quitarle tags mancharía cualquier `<` literal |

Un `content` se toma como lista de adjuntos solo si es un array JSON no vacío y **todos** sus elementos son objetos con `contentUri`. Un array JSON que resulta ser el contenido real (`["a","b"]`) se parsea como texto.

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

### `POST /api/parse/attachment`

La forma explícita de lo mismo, para llamadores que ya tienen el array de adjuntos y no necesitan pasarlo como string. Descarga el primer PDF, extrae su texto y lo parsea con una respuesta enlatada de Genesys como plantilla. La extracción corre en proceso con [unpdf](https://github.com/unjs/unpdf) — no requiere el binding de Workers AI.

**Body:**
```json
{
  "name": "Reporte de siniestro",
  "attachments": [
    {
      "contentLength": 45991,
      "contentType": "application/pdf",
      "contentUri": "https://inin-prod-useast1-conversation-services.s3.amazonaws.com/...",
      "id": "19f9b9824f148d185ad3",
      "name": "103967-2026.pdf"
    }
  ]
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `name` | `string` | Nombre exacto de la respuesta enlatada en Genesys |
| `attachments` | `array` | Adjuntos tal como los manda Genesys: `{contentLength?, contentType?, contentUri, id?, name?}`; se usa el primer PDF |
| `html` | `boolean` | Default `false`: el texto extraído ya es texto plano |

`contentUri` es el único campo obligatorio. Si no hay `contentType` se usa la extensión de `name` (o de la URL). Si `contentLength` supera el máximo (20 MB) se rechaza sin descargar.

---

### `POST /api/extract`

Devuelve el texto plano del PDF, sin plantilla. Es la herramienta de autoría: **las plantillas se escriben contra este texto**, nunca contra cómo se ve el PDF (ver [Reglas de autoría](#reglas-de-autoría-de-plantillas)).

**Body:**
```json
{ "attachments": [{ "contentType": "application/pdf", "contentUri": "https://...", "name": "103967-2026.pdf" }] }
```

`attachments` acepta el array o su representación como string JSON — un Data Action de Genesys con un solo campo de string solo puede mandar lo segundo:
```json
{ "attachments": "[{\"contentType\":\"application/pdf\",\"contentUri\":\"https://...\"}]" }
```

**Respuesta `200`:**
```json
{ "text": "REPORTE GENERAL DE SINIESTRO Impreso: ...", "chars": 1375, "pages": 1, "source": "103967-2026.pdf" }
```

Si el texto sale sospechosamente corto se agrega un campo `warning`: el PDF probablemente es un escaneo y necesitaría OCR.

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
- `{name:regex}` — captures a named variable that matches exactly that regular expression.
- `{...}` — matches (and ignores) any text between surrounding parts (non-greedy). This is useful when the canned response contains variable text you don't want to capture.
- `[ ... ]` — optional section: matches if present, and leaves its variables empty if not.
- `\{`, `\}`, `\[`, `\]` — a literal brace or bracket.

Example:

Content: "Inicio de contenido, hola Marco hoy es el 12/12/2020 y necesito 1,000 adios"

Template: "hola {name} {...} necesito {amount}"

Result: `{ "name": "Marco", "amount": "1,000" }`

## Reglas de autoría de plantillas

Valen para cualquier contenido, pero son obligatorias con PDFs. Usa `POST /api/extract` para ver el texto real antes de escribir la plantilla.

**1. Siempre un literal después de la última variable.** La última variable es greedy: sin nada que la detenga se come el resto del documento.

```
✗  Conductor: {conductor} Teléfono: {telefono}
✓  Conductor: {conductor} Teléfono: {telefono} Ajustadores asignados
```

**2. Escribe contra el texto extraído, no contra el PDF.** Las tablas se aplanan por columna, no por fila: los encabezados salen juntos y luego los valores juntos. Se ancla por la forma del valor.

```
texto:     Asegurado Póliza Siniestro ANGEL DE JESUS MUNGARAY VERGARA 6-781-1504-13 6-741- 1119-2026 Ocurrió
✗  Asegurado: {asegurado} Póliza: {poliza}
✓  Asegurado Póliza Siniestro {asegurado} 6-{poliza} 6-{siniestro} Ocurrió
→  {"asegurado":"ANGEL DE JESUS MUNGARAY VERGARA","poliza":"781-1504-13","siniestro":"741- 1119-2026"}
```

**3. Usa `{variable:regex}` cuando los valores vienen pegados o tienen espacios.** Una variable normal se corta en el espacio siguiente, así que no puede separar `18:206648124743` ni capturar `6-741- 1119-2026` completo. Con un regex la variable captura exactamente lo que el regex describe:

```
texto:     Asegurado Póliza Siniestro ANGEL DE JESUS MUNGARAY VERGARA 6-781-1504-13 6-741- 1119-2026 Ocurrió HoraTeléfono Asegurado 10 de JULIO de 2026 18:206648124743 Inciso:

✓  Asegurado Póliza Siniestro {asegurado:.+?} {poliza:6-[\d-]+} {siniestro:6-[\d\- ]+?} Ocurrió HoraTeléfono Asegurado {ocurrio:\d{1,2} de \w+ de \d{4}} {hora:\d{1,2}:\d{2}}{telefono:\d{10}} Inciso:
→  {"asegurado":"ANGEL DE JESUS MUNGARAY VERGARA","poliza":"6-781-1504-13","siniestro":"6-741- 1119-2026","ocurrio":"10 de JULIO de 2026","hora":"18:20","telefono":"6648124743"}
```

El regex es JavaScript estándar y va tal cual entre `:` y `}` — se permiten cuantificadores con llaves (`\d{4}`) y clases (`[\d\- ]`). Notas:

- **Usa cuantificadores perezosos (`+?`, `*?`) cuando siga un literal**, para que la variable pare en él en vez de seguir de largo.
- Las variables con regex **no** llevan las salvaguardas de las normales (regla 1 no aplica: el regex ya delimita el valor), pero sí siguen la regla 2: se escriben contra el texto extraído.
- Como el regex delimita el valor, dos variables pueden ir pegadas sin separador: `{hora:\d{1,2}:\d{2}}{telefono:\d{10}}`.
- Un regex inválido, vacío o sin `}` de cierre falla con un error que nombra la variable.
- La plantilla que viene de una respuesta enlatada pasa por el limpiador de HTML antes de parsear: evita `<` dentro del regex (se lo come como si abriera un tag) y no dependas de espacios repetidos (se colapsan a uno). Usa `\s+` si necesitas "uno o más espacios".

**4. Usa `{...}` para saltar texto intermedio** en vez de dejar que una variable se coma un párrafo entero.

```
✓  Forma Pago: {forma_pago} Estatus original{...}Agente: {agente} Marca:
→  {"forma_pago":"ANUAL","agente":"WILLIS AGENTE DE SEGUROS Y DE FIANZAS 2"}
```

Los dos PDFs de [`samples/`](samples/) y sus plantillas validadas están cubiertos por [`tests/templates.test.mjs`](tests/templates.test.mjs).

## Genesys Cloud Function

`POST /api/parse/template` tiene un equivalente autocontenido que corre como Genesys Cloud Function, para flujos de Architect que no pueden salir a un Worker. Ambos comparten el mismo núcleo ([`src/core.ts`](src/core.ts), [`src/attachments.ts`](src/attachments.ts), [`src/genesys.ts`](src/genesys.ts)) y producen texto idéntico para el mismo PDF; lo único propio de la Function es el adaptador [`functions/handler.mjs`](functions/handler.mjs).

**Input Contract:**

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `name` | string | sí | Nombre de la respuesta enlatada |
| `content` | string | uno de los dos | Texto a parsear, o el array JSON de adjuntos |
| `attachments` | array \| string | uno de los dos | Adjuntos como array o como string JSON |
| `html` | string \| boolean | no | `"false"` para no limpiar tags. Los Data Actions tipan todo como string, así que se acepta cualquiera de los dos |

**Output Contract:** `{ resultJson: string, error: string }`. La función nunca lanza: Architect verifica `error === ""` y luego hace `JSON.parse(resultJson)`.

**Credenciales** (Headers del Data Action): `authorization: Basic <base64(clientId:clientSecret)>` — o `x-genesysclientid` + `x-genesysclientsecret` por separado — más `genesys-library-id`, y opcionalmente `genesys-debug: true`.

Detalles de diseño y del despliegue en Genesys: [`docs/genesys-functions-plan.md`](docs/genesys-functions-plan.md).

### Generar la versión de código

```bash
pnpm build:function                  # versión desde package.json + git
pnpm build:function --version 1.4.0  # versión explícita
```

Produce `functions/dist/gr-parse-attachment-<versión>.zip` (~500 KB, un solo `index.js`, sin `node_modules`), que es lo que se sube en Genesys. La versión sale de `package.json` más el commit corto — `1.0.0+a201d8f` — y queda estampada en el bundle: se registra en el log de cada cold start y se emite en los logs de debug, así se puede rastrear qué bundle está respondiendo. Un sufijo `-dirty` indica que el bundle se armó con cambios sin commitear y no debería publicarse.

| Campo en Genesys | Valor |
|---|---|
| Handler | `index.handler` |
| Runtime | `nodejs20.x` (arm64) |
| Timeout | 15 s |
| Memory | 1024 MB |

El resto de la configuración de runtime está en [`functions/serverless.yml`](functions/serverless.yml).

## Pruebas

```bash
pnpm test        # node --test: extracción, plantillas y contrato de la Function
pnpm typecheck   # tsc --noEmit
```

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
