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

Es el endpoint genérico: **si `content` es un array JSON de adjuntos o un URL de un PDF, se trata como tal** — se descarga el PDF y se parsea su texto. Esto permite que un llamador con un solo campo de string (un Data Action de Genesys, por ejemplo) mande cualquiera de las dos cosas.

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
| `content` | `string` | Contenido del que se extraen los valores, el array JSON de adjuntos, o el URL de un PDF |
| `html` | `boolean` | Si `true` (default), limpia tags HTML y entidades antes de parsear. Se ignora cuando el contenido salió de un PDF: ese texto ya es plano y quitarle tags mancharía cualquier `<` literal |

Un `content` se toma como lista de adjuntos solo si es un array JSON no vacío y **todos** sus elementos son objetos con `contentUri`. Un array JSON que resulta ser el contenido real (`["a","b"]`) se parsea como texto.

Un `content` se toma como URL de un PDF solo si **todo** el texto (sin espacios al inicio o al final) es un único URL `http(s)`. Un texto que solo contiene un link (`Ver https://...`) sigue siendo texto. El URL debe ser de descarga directa: si responde con algo que no es un PDF, la llamada falla con `... is not a PDF`.

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

## Genesys Cloud Functions

Las capacidades del Worker tienen equivalentes autocontenidos que corren como Genesys Cloud Functions, para flujos de Architect que no pueden salir a un Worker. No se "convierte" el Worker: ambos son adaptadores delgados sobre el mismo núcleo en `src/`, y producen texto idéntico para el mismo PDF.

```
src/parser.ts, src/genesys.ts, src/core-text.ts   texto: sin unpdf (~7 KB)
src/attachments.ts, src/core.ts                   PDF: arrastran unpdf (~1.6 MB)
        │
        ├── src/index.ts                Worker (Hono/chanfana, HTTP)
        └── functions/<función>.mjs     Genesys Function (event + clientContext)
              + functions/_runtime.mjs   contrato, headers y coerciones compartidos
              + functions/manifest.mjs   qué funciones se construyen y su configuración
```

| Function | Equivale a | Entrada | Credenciales |
|---|---|---|---|
| `gr-parse-attachment` | `POST /api/parse/template` | `name`, `content` o `attachments`, `html` | sí |
| `gr-extract-pdf` | `POST /api/extract` | `source`: URL o JSON de adjuntos | no |

### Contrato común

**Salida:** la función devuelve su objeto de resultado tal cual, o `{ "error": "<mensaje>" }` si falla. Nunca lanza: Architect verifica si existe `error` y ramifica. Por eso **`error` es una llave reservada**: una plantilla con una variable `{error}` se rechaza con un error que pide renombrarla.

**Headers** (`clientContext` del Data Action, sin importar mayúsculas): `authorization: Basic <base64(clientId:clientSecret)>` — o `x-genesysclientid` + `x-genesysclientsecret` por separado — más `genesys-library-id`, y opcionalmente `genesys-debug: true`. Solo las funciones que consultan la API de Genesys los exigen.

Los Data Actions tipan todo como string, así que los booleanos aceptan `"true"`/`"false"` y los arrays su representación JSON.

### `gr-parse-attachment`

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `name` | string | sí | Nombre de la respuesta enlatada |
| `content` | string | uno de los dos | Texto a parsear, el array JSON de adjuntos, o el URL de un PDF |
| `attachments` | array \| string | uno de los dos | Adjuntos como array o como string JSON |
| `html` | string \| boolean | no | `"false"` para no limpiar tags. Se ignora cuando el contenido salió de un PDF |

`content` se interpreta igual que en `POST /api/parse/template`. Con un URL se puede probar una plantilla desde la pestaña **Test** del Data Action pegando solo el link del PDF, igual que con `gr-extract-pdf`.

Salida: las variables de la plantilla, p. ej. `{ "asegurado": "...", "poliza": "..." }`.

### `gr-extract-pdf`

Herramienta de autoría: devuelve el texto exacto contra el que se escribe la plantilla (ver [Reglas de autoría](#reglas-de-autoría-de-plantillas)). El mismo Data Action sirve a una persona desde la pestaña **Test** en Genesys, sin código, y a Architect con los adjuntos de una conversación de correo.

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `source` | string \| array | sí | Una URL pública `http(s)` de **descarga directa** del PDF, **o** el array JSON de adjuntos tal como lo manda Genesys (se usa el primer PDF) |

`source` usa la misma detección que `content` en `gr-parse-attachment`: si es un array JSON no vacío cuyos elementos tienen todos `contentUri`, es una lista de adjuntos; si es un único URL `http(s)`, es el PDF a descargar. Cualquier otra cosa es un error (aquí no hay texto que parsear).

```json
{ "source": "https://ejemplo.com/reporte.pdf" }
{ "source": "[{\"contentType\":\"application/pdf\",\"contentUri\":\"https://...\",\"name\":\"103967-2026.pdf\"}]" }
```

Salida: `{ "text": "...", "chars": 1375, "pages": 1, "source": "103967-2026.pdf", "warning": "" }`. En la salida, `source` es el nombre del archivo del que salió el texto. `warning` siempre viene (vacío si todo bien) y avisa cuando el texto sale tan corto que el PDF parece un escaneo. Un link de "compartir" que responde con una página HTML en vez del archivo se reporta como `... is not a PDF (content-type: text/html ...) — is the URL a direct download link?`.

### Generar los zips

```bash
pnpm build:function                            # todas las funciones, versión desde package.json + git
pnpm build:function --only gr-extract-pdf      # una sola
pnpm build:function --version 1.4.0            # versión explícita
```

Por cada función produce `functions/dist/<nombre>-<versión>.zip` (~500 KB con unpdf, un solo `index.js`, sin `node_modules`), que es lo que se sube en Genesys, e imprime los valores a capturar en su UI:

```
gr-extract-pdf
  zip      functions/dist/gr-extract-pdf-1.0.0_a8c7abb.zip (493 KB)
  bundle   1592 KB (unpdf 1588 KB)
  genesys  handler index.handler · nodejs22.x arm64 · 1024 MB · 15 s
```

La versión sale de `package.json` más el commit corto — `1.0.0+a201d8f` — y queda estampada en el bundle junto con el nombre de la función: se registra en el log de cada cold start y en los logs de debug. Un sufijo `-dirty` indica cambios sin commitear y no debería publicarse. El zip es determinista: el mismo commit produce el mismo archivo byte por byte.

La configuración de cada función (memoria, timeout, descripción) vive en [`functions/manifest.mjs`](functions/manifest.mjs); Genesys se configura por su propia UI, así que no hay archivo de despliegue.

### Agregar una capacidad nueva

1. **La lógica** en `src/`, sin dependencias de Hono ni de Lambda. Si no lee PDFs, que no importe `src/core.ts` ni `src/attachments.ts` (usa `src/core-text.ts`).
2. **La ruta del Worker** en [`src/index.ts`](src/index.ts), si aplica.
3. **El adaptador** en `functions/<nombre>.mjs`: `export const handler = defineFunction(async (event, { headers, debug }) => …)`. Valida sus entradas y llama a `src/`; el contrato, los headers y el manejo de errores ya vienen de [`functions/_runtime.mjs`](functions/_runtime.mjs).
4. **La entrada** en [`functions/manifest.mjs`](functions/manifest.mjs). Con `pdf: false` el build falla si la función termina arrastrando unpdf.
5. **Tests** del comportamiento propio. El de build ([`tests/build.test.mjs`](tests/build.test.mjs)) ya cubre automáticamente que cada función del manifiesto construya, cargue y respete el contrato.

Detalles de diseño y del despliegue en Genesys: [`docs/genesys-functions-plan.md`](docs/genesys-functions-plan.md).

## Pruebas

```bash
pnpm test        # node --test: extracción, plantillas, Worker, Functions y build de cada zip
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
