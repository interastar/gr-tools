# Versión standalone para Genesys Cloud Functions

> Estado: **Fases 0–4 implementadas**, más una segunda etapa (manifiesto de funciones, runtime
> común y `gr-extract-pdf`) descrita en [Etapa 2](#etapa-2--varias-functions-desde-un-manifiesto).
> Falta lo que no se puede hacer desde el repo: subir los zips a Genesys y crear los Function Data
> Actions (ver [Pendiente](#pendiente)).
>
> Lo entregado y lo que se desvió del plan está al final, en
> [Resultado de la implementación](#resultado-de-la-implementación). El cuerpo del documento se
> conserva como registro de las decisiones de diseño. **El contrato de salida cambió** después
> de la Fase 4 (ver [Etapa 2](#etapa-2--varias-functions-desde-un-manifiesto)): las secciones que
> mencionan `{ resultJson, error }` describen el diseño original, no el vigente.

## Contexto

`POST /api/parse/attachment` (ya en `master`) recibe adjuntos con mime-types y el nombre de una
canned response, baja el primer PDF, lo convierte a texto y lo parsea con la plantilla.

La conversión usa `env.AI.toMarkdown()`, binding exclusivo de Cloudflare. Queremos una versión
alterna autocontenida como Genesys Cloud Function (Lambda dentro de Genesys). **El binding AI es
el único bloqueador**: [`parser.ts`](../src/parser.ts) es puro sin imports, y hono/chanfana/zod
son solo la capa HTTP que Lambda no necesita.

### Restricciones de Genesys Cloud Functions (verificadas)

| Restricción | Valor | Implicación |
|---|---|---|
| Handler | `exports.handler = async (event, context, callback)` | Sin HTTP → hono/chanfana sobran |
| Runtime | Node.js (`nodejs20.x`, hoy `nodejs22.x` — ver [Pendiente](#pendiente)), arm64 | Fija la versión de unpdf |
| Timeout | **1–15 s** | Crítico: hay que paralelizar la red |
| ZIP | 256 MB | Tamaño del bundle irrelevante |
| Respuesta | 2 MB | Suficiente |
| Red | Salida a internet sí; sin IP estática ni VPC | Se puede bajar el PDF y llamar la API |
| AWS | **No** puede tocar S3/DynamoDB/SQS | No aplica |
| Credenciales | `context.clientContext` (normalizado a lowercase) | Reemplazan vars/secrets de wrangler |

[Add Function configuration](https://help.genesys.cloud/articles/add-function-configuration/) ·
[Limitations](https://help.genesys.cloud/articles/limitations-of-the-genesys-cloud-function-data-actions-integration/) ·
[devdrop-example](https://github.com/MyPureCloud/quick-hits-javascript/tree/main/genesys-functions/devdrop-example)

---

## Fase 0 — VALIDADA

Corrida contra `samples/` con `unpdf@1.7.0` + el `parseTemplate` real del repo.

**unpdf aprobado.** Ambos PDFs son generados (iText 5.0.4 / Adobe Central Output), con `/Font` y
cero códecs de imagen. Texto completo y legible en **52 ms y 271 ms**. Sin riesgo de OCR.

**Inventario de campos:**

| Archivo | Extraíble | Perdido |
|---|---|---|
| `103967-2026.pdf` | 47 / 47 con una sola plantilla | ninguno |
| `20260710_1119.pdf` | todos los campos | corte entre Hora Ocurrió y Teléfono Asegurado |

La única pérdida es que `18:20` y `6648124743` salen pegados como `18:206648124743`. El dato no
se pierde, solo el corte; Architect lo parte con substring (formato fijo `HH:MM` + 10 dígitos).

El bloque tabular de `20260710_1119.pdf` (que pdf.js aplana como
`Asegurado Póliza Siniestro <val> <val> <val>`) **sí se recupera** anclando por forma del valor,
sin tocar el parser:

```
Asegurado Póliza Siniestro {asegurado} 6-{poliza} 6-{siniestro} Ocurrió
→ {"asegurado":"ANGEL DE JESUS MUNGARAY VERGARA","poliza":"781-1504-13","siniestro":"741- 1119-2026"}
```

### Tres hallazgos que condicionan el diseño

1. **Hay que aplanar el whitespace** (`text.replace(/\s+/g,' ').trim()`) antes de parsear — la
   misma normalización que ya hace [`stripHtml`](../src/parser.ts#L45). Sin eso el flag `s` del
   regex hace que la última variable cruce saltos de línea y se coma el documento.
2. **La última variable es greedy** (`isLast ? ".*" : ".*?"` en
   [`parser.ts:148`](../src/parser.ts#L148)). Con emails de una línea no se notaba; con un PDF sí.
   → Regla de autoría: **siempre un literal después de la última variable.**
3. **Las tablas se aplanan por columna**, no por fila. Una plantilla "visual" (`Asegurado: {x}`)
   falla. → Las plantillas se escriben contra el texto extraído, nunca contra cómo se ve el PDF.
   De ahí el endpoint de preview de la Fase 3.

### Decisiones tomadas

- **Extractor:** unpdf en ambas versiones.
- **Tablas:** se acepta la limitación. **Sin cambios a `parser.ts`.**
- **Plantilla:** se sigue consultando la API de Genesys (hay límite de tamaño del cuerpo).
- **Autoría:** endpoint de preview.
- **Salida de la Function:** objeto JSON con `resultJson` (string) y `error` (string).
  *Reemplazado en `a8c7abb`: el objeto de resultado tal cual, o `{ error }`.*

---

## Fase 1 — Extraer el núcleo compartido

Hoy [`index.ts`](../src/index.ts) mezcla routing, auth de Genesys, extracción de PDF y
orquestación. Se separa en módulos runtime-agnósticos que ambos adaptadores consumen.

```
src/
  parser.ts        # SIN CAMBIOS — puro, cero imports
  genesys.ts       # NUEVO ← mover getGenesysToken, parseCandidates,
                   #         getGenesysCannedResponse desde index.ts
  attachments.ts   # NUEVO ← isPdf, descarga, extracción unpdf + aplanado
  core.ts          # NUEVO ← parseAttachment(): orquestación compartida
  index.ts         # ADELGAZA ← solo hono/chanfana y las clases OpenAPIRoute
  types.ts         # quitar `AI: Ai` de Env
functions/
  handler.js       # NUEVO ← handler de Genesys (JavaScript plano, sin transpilación)
  serverless.yml   # NUEVO
  build.mjs        # NUEVO ← esbuild + zip
```

`attachments.ts` — el aplanado va aquí, no en el llamador:

```ts
const { text } = await extractText(new Uint8Array(buf), { mergePages: true })
return text.replace(/\s+/g, ' ').trim()
```

`core.ts` — no sabe nada de hono ni de Lambda:

```ts
export async function parseAttachment(input: {
  name: string
  attachments: Attachment[]
  auth: { authHeader: string }
  libraryId: string
  debug?: boolean
}): Promise<ParseResult>
```

Dentro, **paralelizar** — es lo que hace viable el presupuesto de 15 s:

```ts
const [content, { template, candidates }] = await Promise.all([
  extractPdfText(attachments),          // fetch + unpdf
  getTemplate(auth, libraryId, name),   // token + responsemanagement
])
return parseTemplate(template, content, false, candidates)
```

Sin esto son 4 viajes de red en serie (token → responses → descarga → parseo) que en cold start
pueden rozar los 15 s.

Node 20 ya trae `fetch`, `btoa`, `Blob` y `URL` como globals: sin polyfills. `zod` se queda solo
en el Worker; el Lambda valida a mano (son 4 campos).

## Fase 2 — Cambiar el Worker a unpdf

- `pnpm add unpdf` — **fijar `unpdf@1.7.0`** si Genesys solo ofrece Node 20; la `1.8.0` declara
  `engines: node >=22`. Confirmar en la UI de Genesys qué runtimes hay antes de fijar.
- `extractPdfContent()` en [`index.ts:239`](../src/index.ts#L239) pasa a usar `extractText` en vez
  de `c.env.AI.toMarkdown()`.
- Quitar el binding `"ai"` de [`wrangler.jsonc`](../wrangler.jsonc#L44) y `AI: Ai` de
  [`types.ts`](../src/types.ts#L7); correr `wrangler types`.
- **Vigilar el bundle:** hoy 830 KB / 141 KB gzip; unpdf agrega ~2 MB sin comprimir. Límite de
  Workers: 3 MB gzip (free) / 10 MB (paid). Confirmar con `wrangler deploy --dry-run`.
- `/api/parse` y `/api/parse/template` no se tocan.

## Fase 3 — Endpoint de preview

`POST /api/extract` — mismo body de adjuntos, sin `name` ni plantilla. Devuelve:

```json
{ "text": "<texto aplanado>", "chars": 1832, "pages": 2, "source": "20260710_1119.pdf" }
```

Reusa `attachments.ts` completo; es una clase `OpenAPIRoute` de ~30 líneas. Quien redacta la
canned response lo llama primero y escribe la plantilla contra lo que realmente hay. Dados los
hallazgos 2 y 3 de la Fase 0, esto no es un extra: sin él las plantillas se escriben a ciegas.

Documentar en el README las dos reglas de autoría (literal final, comodín `{...}`) con los
ejemplos reales de `samples/`.

## Fase 4 — El handler de Genesys

### Contrato de entrada

El handler recibe dos fuentes de datos: `event` (Input Contract del Data Action) y
`context.clientContext` (Credentials/Headers configurados en Genesys).

**`event` — Input Contract:**

La función es un parser genérico: el contenido puede ser texto o un PDF adjunto, y el handler
decide cuál es. Se requiere `content` o `attachments`.

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `name` | string | sí | Nombre de la canned response en la librería |
| `content` | string | uno de los dos | Texto a parsear, **o** el array JSON de adjuntos |
| `attachments` | array \| string | uno de los dos | Array de adjuntos tal como los manda Genesys (`{contentLength, contentType, contentUri, id, name}`), o su representación como JSON string (los Data Actions de Genesys pueden serializar arrays como string) |
| `html` | string \| boolean | no | `"false"` para no limpiar tags. Se ignora cuando el contenido salió de un PDF |

Las tres formas de mandar el mismo adjunto:
```json
{ "attachments": [{ "contentType": "application/pdf", "contentUri": "https://...", "name": "x.pdf" }] }
{ "attachments": "[{\"contentType\":\"application/pdf\",\"contentUri\":\"https://...\"}]" }
{ "content":     "[{\"contentType\":\"application/pdf\",\"contentUri\":\"https://...\"}]" }
```

La tercera es la que importa: un Data Action con un solo campo de string puede mandar texto o
adjuntos por el mismo input, sin necesitar dos acciones distintas. Un `content` se toma como
lista de adjuntos solo si es un array JSON no vacío y **todos** sus elementos son objetos con
`contentUri`; si no, es texto.

Los Data Actions tipan todo como string, así que `html` acepta `"true"`/`"false"` además del
booleano.

**`context.clientContext` — Headers/Credentials en Genesys:**

Las keys se normalizan a lowercase al inicio del handler para evitar problemas de capitalización
entre plataformas (lección aprendida: Genesys puede entregar `Authorization` o `authorization`
indistintamente).

| Header (lowercase) | Requerido | Descripción |
|---|---|---|
| `authorization` | condicional | `Basic <base64(clientId:clientSecret)>` — tiene prioridad si está presente |
| `x-genesysclientid` | condicional | Client ID de OAuth; usado si no hay `authorization` |
| `x-genesysclientsecret` | condicional | Client Secret de OAuth; usado junto con `x-genesysclientid` |
| `genesys-library-id` | sí | ID de la librería de canned responses |
| `genesys-debug` | no | `"true"` activa logs detallados en CloudWatch |

Se requiere **una de las dos formas** de credencial:
- Forma A (preferida): `authorization: Basic <base64>` — consistente con `gr-parse-template`
- Forma B: `x-genesysclientid` + `x-genesysclientsecret` por separado — compatibilidad con el esquema original del plan

### Contrato de salida

> **Vigente desde `a8c7abb`:** la función devuelve el objeto de resultado tal cual
> (`{ "asegurado": "...", "poliza": "..." }`) o `{ "error": "<mensaje>" }`, y `error` es una
> llave reservada para las variables de plantilla. Lo que sigue es el diseño original.

La función **nunca lanza excepciones hacia Genesys**. Los errores se capturan y se devuelven en
el campo `error` para que Architect pueda ramificar sin manejar un fallo de acción.

**Éxito:**
```json
{ "resultJson": "{\"asegurado\":\"ANGEL DE JESUS...\",\"poliza\":\"781-1504-13\"}", "error": "" }
```

**Error:**
```json
{ "resultJson": "", "error": "Canned response not found: \"MiPlantilla\"" }
```

Architect extrae los campos del PDF con `JSON.parse(resultJson)` en una expresión de datos, y
verifica `error === ""` antes de continuar el flujo.

> **Diferencia con `gr-parse-template`:** ese handler usa `callback(e)` para errores porque
> devuelve el objeto de resultado directamente. El handler de adjuntos prefiere el contrato
> `{ resultJson, error }` porque el parsing de JSON string en Architect es más predecible que
> manejar un output variable dependiendo de si hubo error.

### Implementación

El adaptador vive en [`functions/handler.mjs`](../functions/handler.mjs) y es solo eso: normaliza
las keys de `clientContext` a minúsculas, arma el header `Basic` si vienen id y secret por
separado, coacciona `attachments` y `html` desde los strings que mandan los Data Actions, y
envuelve todo en el contrato `{ resultJson, error }`. La lógica está en
[`src/core.ts`](../src/core.ts) — `parseWithTemplate()`, compartida con el Worker, que es también
la que decide si el `content` es texto o una lista de adjuntos.

### Configuración de runtime

En [`functions/serverless.yml`](../functions/serverless.yml): `nodejs20.x` arm64, 1024 MB de
memoria (unpdf consume más que el parser de emails) y el timeout máximo de 15 s. Genesys se
configura por su propia UI, así que el archivo es el registro escrito de esos valores — y permite
desplegar el mismo bundle a una cuenta de AWS para pruebas de carga.

### Generación de la versión de código

`pnpm build:function` ([`functions/build.mjs`](../functions/build.mjs)) hace tres cosas:

1. **Bundle:** esbuild empaqueta `handler.mjs` y todo `src/` (TypeScript incluido: el bundler
   resuelve los `.ts` directamente) a un solo CJS minificado. Sin externals, sin `node_modules`.
2. **Versión:** `<versión de package.json>+<commit corto>`, o `--version X.Y.Z` explícito. Se
   inyecta con `define` como `__CODE_VERSION__`, se loguea en cada cold start y aparece en los
   logs de debug, así se puede saber qué bundle está respondiendo en Genesys. El sufijo `-dirty`
   marca un bundle armado con cambios sin commitear.
3. **Zip:** escritor propio sobre `node:zlib` — sin dependencias, con timestamps fijos para que el
   mismo código produzca siempre el mismo zip.

Salida: `functions/dist/gr-parse-attachment-<versión>.zip`, ~500 KB, un solo `index.js` en la raíz
(handler `index.handler`).

---

## Verificación

1. **Paridad Worker↔Lambda:** el mismo PDF por ambos caminos, diff del texto extraído. Deben ser
   idénticos (mismo unpdf, mismas opciones).
2. **Regresión de plantillas:** un test con los dos PDFs de `samples/` y las plantillas ya
   validadas en la Fase 0, verificando los 47 campos de `103967-2026.pdf`. Esto ancla el
   comportamiento antes de refactorizar.
3. **Worker:** `wrangler dev` → `/api/extract` y `/api/parse/attachment` con adjunto real y
   `Genesys-Debug: true`. `tsc --noEmit` + `wrangler deploy --dry-run` (revisar tamaño).
4. **Lambda local:** invocar el handler directamente desde Node con un `event` y `context` de prueba:
   ```js
   const { handler } = require('./dist/index')
   const result = await handler(
     { name: 'MiPlantilla', attachments: [{ contentType: 'application/pdf', contentUri: 'file://...' }] },
     { clientContext: { authorization: 'Basic <base64>', 'genesys-library-id': '<id>' } }
   )
   console.log(result)
   ```
   **Cronometrar** — el número que importa es si cabe en 15 s con cold start.
5. **En Genesys:** subir el zip, crear el Function Data Action con el Output Contract
   `{ resultJson: string, error: string }`, correr desde la UI de Test y revisar Flow Playback.

## Riesgos

- **Timeout de 15 s** → mitigado con `Promise.all`. Si sigue apretado, la siguiente palanca:
  `getGenesysCannedResponse` hoy baja **las 200 respuestas** de la librería y filtra por nombre
  en el cliente; conviene el endpoint de búsqueda. Mejora independiente que también beneficia
  al Worker.
- **PDFs escaneados a futuro** → unpdf devuelve vacío. Los dos ejemplos actuales son generados,
  pero si aparece una aseguradora que mande escaneos hay que agregar OCR. Vale la pena que
  `/api/extract` avise cuando el texto sale sospechosamente corto.
- **Runtime Node en Genesys** → confirmar versiones disponibles antes de fijar unpdf.

---

## Apéndice — script de validación

Reproduce la Fase 0. Requiere `unpdf` instalado y Node 22+ (por `--experimental-strip-types`):

```js
// scripts/check-pdf.mjs
// uso: node --experimental-strip-types scripts/check-pdf.mjs samples/*.pdf
import { readFile } from 'node:fs/promises'
import { extractText } from 'unpdf'

for (const file of process.argv.slice(2)) {
  const t0 = Date.now()
  const { text, totalPages } = await extractText(
    new Uint8Array(await readFile(file)), { mergePages: true })
  const flat = text.replace(/\s+/g, ' ').trim()
  console.log(`\n===== ${file} | ${totalPages} pag | ${flat.length} chars | ${Date.now() - t0} ms =====`)
  console.log(flat)
}
```

Plantillas ya validadas contra `samples/20260710_1119.pdf`:

```
Estimado(a) agente: {agente} El dar
Asegurado Póliza Siniestro {asegurado} 6-{poliza} 6-{siniestro} Ocurrió
HoraTeléfono Asegurado {dia} de {mes} de {anio} {hora_tel} Inciso:
Inciso: {inciso} Numero de Serie: {serie} Nombre del Ajustador: {ajustador} Lugar del Siniestro: {lugar} Descripcion de la Unidad: {unidad} Tipo de Servicio: {tipo_serv} Numero Economico: {economico} Nombre del Conductor: {conductor} Descripcion del Siniestro: {desc} Te sugerimos
Estatus {estatus} Registro Sistema GS {registro} General de Seguros
```

Ejemplo del comodín `{...}` para saltar texto intermedio (así se arregló `forma_pago`, que se
estaba comiendo un párrafo entero):

```
Forma Pago: {forma_pago} Estatus original{...}Agente: {agente} Marca:
→ {"forma_pago":"ANUAL","agente":"WILLIS AGENTE DE SEGUROS Y DE FIANZAS 2"}
```

---

## Resultado de la implementación

### Lo que quedó

```
src/
  parser.ts        sin cambios
  genesys.ts       NUEVO   token, parseCandidates, canned response, getTemplate()
  attachments.ts   NUEVO   isPdf, descarga, unpdf, aplanado de whitespace
  core.ts          NUEVO   parseWithTemplate(): orquestación compartida; texto o adjuntos
  index.ts         adelgazado; + POST /api/extract
  types.ts         sin `AI: Ai`
functions/
  handler.mjs      adaptador de Genesys ({resultJson, error})
  build.mjs        esbuild + versionado + zip
  serverless.yml   configuración de runtime
tests/
  templates.test.mjs  extracción + las plantillas de la Fase 0
  handler.test.mjs    contrato del handler (offline)
  e2e.test.mjs        cadena completa con la API de Genesys simulada
```

`wrangler.jsonc` ya no declara el binding `ai`.

### Desviaciones del plan

| Plan | Implementado | Por qué |
|---|---|---|
| `handler.js` en CJS | `handler.mjs` en ESM | esbuild lo emite como `exports.handler`; en ESM el bundle de pruebas expone exports con nombre |
| `token` antes del `Promise.all` | `getTemplate()` (token + búsqueda) dentro del paralelo | el PDF no necesita el token; así la descarga arranca sin esperar el login |
| `Promise.all` | `Promise.allSettled` + re-throw del primer error | con `Promise.all` el rechazo del perdedor queda sin manejar y tumba el proceso del Lambda |
| zip con `7z` | escritor de zip propio en `build.mjs` (`node:zlib`) | ni `7z` ni `zip` están garantizados en Windows ni en CI; sin dependencias y reproducible |
| zip con `dist/index.js`, handler `dist/index.handler` | `index.js` en la raíz del zip, handler `index.handler` | `dist/` en la raíz del repo es la salida de wrangler; la de la Function vive en `functions/dist/` |
| — | versión de código estampada en el bundle | trazar qué bundle está corriendo en Genesys (`1.0.0+a201d8f`, de `package.json` + commit) |

### Verificación ejecutada

1. **Paridad Worker↔Lambda:** el texto extraído es idéntico carácter por carácter en workerd y en
   Node para los dos PDFs de `samples/` (1375 y 1832 chars). unpdf corre sin problemas dentro de workerd.
2. **Regresión de plantillas:** 26 pruebas en verde (`pnpm test`), incluidos los 52 campos de
   `103967-2026.pdf` con una sola plantilla y las 5 plantillas validadas de `20260710_1119.pdf`.
3. **Worker:** `tsc --noEmit` limpio; `wrangler deploy --dry-run` da **3090 KB / 694 KB gzip**,
   holgado contra el límite de 3 MB gzip del plan gratuito. `/api/extract` probado en `wrangler dev`.
4. **Lambda local:** el zip se descomprime y el `index.js` empaquetado responde el contrato
   completo en **93 ms en frío y 8 ms en caliente** (sin contar los viajes reales a Genesys, que
   son tres y de los cuales dos se solapan). Presupuesto de 15 s con margen amplio.

### Pendiente

- Subir `functions/dist/gr-parse-attachment-<versión>.zip` a Genesys, crear el Function Data Action
  con un Output Contract que declare las variables de la plantilla más `error`, y probarlo desde la
  UI de Test y Flow Playback.
- Subir `functions/dist/gr-extract-pdf-<versión>.zip` y crear su Data Action: Input Contract
  `{ source: string }`, Output Contract `{ text: string, chars: integer, pages: integer, source: string,
  warning: string, error: string }`. Sin credenciales.
- **Runtime: resuelto.** Genesys marcó `nodejs20.x` como deprecado y pide `nodejs22.x`; el
  manifiesto y el `target` de esbuild ya están en Node 22. `unpdf` sigue fijado en `1.7.0`, que
  corre igual en Node 22. Subir a `1.8.0+` ya es posible, pero es un cambio aparte: puede cambiar
  el texto extraído y con él las plantillas, así que hay que hacerlo con los tests de
  `samples/` como red.

---

## Etapa 2 — Varias Functions desde un manifiesto

Validación hecha antes de empezar, contra `a8c7abb`:

| Hallazgo | Estado |
|---|---|
| `a8c7abb` cambió la salida a objeto crudo / `{ error }`, pero tests y documentación seguían en `{ resultJson, error }` | confirmado: 9 de 49 tests fallando (7 en `e2e`, 2 en `handler`) |
| `serverless.yml` declaraba `dist/gr-parse-attachment.zip`; el build genera `<nombre>-<versión>.zip` | confirmado |
| `build.mjs` con nombre, entrada y zip fijos | confirmado |
| todo lo que importa `core.ts` arrastra unpdf | confirmado: 1,626 KB de 1,636 KB del bundle; una función solo de texto pesa ~7 KB |

### Decisiones

- **Contrato de salida:** se queda el de `a8c7abb` (objeto crudo, o `{ error }`). `error` pasa a
  ser llave reservada: si una plantilla captura `{error}`, la función responde con un error que
  pide renombrar la variable, para que un resultado nunca se confunda con un fallo.
- **`serverless.yml` eliminado:** Genesys no lo usa (se configura por su UI). La memoria, el
  timeout y la descripción de cada función viven en `functions/manifest.mjs`, y el build los
  imprime junto a cada zip.

### Lo que quedó

```
src/
  core-text.ts         NUEVO   parseTextWithTemplate() y helpers; no importa attachments → sin unpdf
  core.ts              usa core-text; contrato y comportamiento sin cambios
  attachments.ts       + verificación de firma %PDF- y shortTextWarning()
functions/
  manifest.mjs         NUEVO   lista de funciones: nombre, entrada, pdf, memoria, timeout
  _runtime.mjs         NUEVO   defineFunction(): headers, coerciones, contrato, llave reservada
  parse-attachment.mjs (antes handler.mjs) adaptador de ~25 líneas
  extract-pdf.mjs      NUEVO   gr-extract-pdf: source (URL o JSON de adjuntos) → { text, chars, pages, source, warning }
  build.mjs            recorre el manifiesto; --only, --version; guarda de unpdf
tests/
  build.test.mjs       NUEVO   cada función del manifiesto construye, carga y respeta el contrato
  extract.test.mjs     NUEVO   gr-extract-pdf contra los PDFs de samples/
```

`gr-extract-pdf` recibe un solo campo `source` que puede ser una URL pública o el array JSON de
adjuntos de una conversación de correo (la misma detección que `content` en `gr-parse-attachment`):
un Data Action con un solo string sirve tanto para quien prueba desde la pestaña Test como para
Architect.

Cada función se publica como su propio zip (`functions/dist/<nombre>-<versión>.zip`, handler
`index.handler`), así que una función de solo texto no carga unpdf. Una entrada con `pdf: false`
hace fallar el build si la función termina importando `core.ts` o `attachments.ts`.

**Firma `%PDF-`:** un link público de "compartir" suele responder con una página HTML de vista
previa en lugar del archivo. Antes eso salía como un error críptico de pdf.js; ahora la descarga
se valida y el error dice que el archivo no es un PDF y muestra su `content-type`. Aplica también
a `gr-parse-attachment` y al Worker: solo cambia el mensaje de un caso que ya era error.

### Verificación ejecutada

- `pnpm test`: **67 de 67** en verde (antes 40 de 49).
- `tsc --noEmit` limpio; `wrangler deploy --dry-run`: 3,095 KiB / 695 KiB gzip (antes 3,090 / 694).
- `pnpm build:function` genera los dos zips (~495 KB cada uno).
