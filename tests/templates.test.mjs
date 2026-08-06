/**
 * Regression anchor for PDF extraction + template parsing.
 *
 * The samples are served over a throwaway HTTP server so the test exercises the
 * real `extractPdfText` path (download -> unpdf -> whitespace flattening) that
 * both the Worker and the Genesys Function use, not just `parseTemplate`.
 *
 * Templates below are the ones validated in Phase 0 of docs/genesys-functions-plan.md.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bundleForTest, samplesDir } from "./_bundle.mjs";

const core = await bundleForTest("tests/_entry.ts", "core.test.mjs");

let server;
let origin;

before(async () => {
	server = createServer((req, res) => {
		const name = decodeURIComponent(req.url.split("?")[0].replace(/^\//, ""));
		res.writeHead(200, { "Content-Type": "application/pdf" });
		createReadStream(join(samplesDir, name)).pipe(res);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// the Genesys shape: { contentLength, contentType, contentUri, id, name }
const extract = (file, contentType = "application/pdf") =>
	core.extractPdfText([{ contentType, contentUri: `${origin}/${file}`, id: "19f9b9824f148d185ad3", name: file }]);

/* ------------------------------------------------------------ extraction */

test("extracts text from a generated PDF", async () => {
	const { text, chars, pages, source } = await extract("103967-2026.pdf");
	assert.equal(pages, 1);
	assert.equal(source, "103967-2026.pdf");
	assert.equal(chars, text.length);
	assert.ok(chars > 1000, `expected a text PDF, got ${chars} chars`);
	// whitespace is flattened: without this the greedy last variable of a
	// template runs across line breaks and swallows the rest of the document
	assert.ok(!/\s\s|\n/.test(text));
	assert.ok(text.startsWith("REPORTE GENERAL DE SINIESTRO"));
});

test("merges every page of a multi-page PDF", async () => {
	const { pages, chars } = await extract("20260710_1119.pdf");
	assert.equal(pages, 2);
	assert.ok(chars > 1500);
});

test("falls back to the file extension when no mime-type is given", async () => {
	const { source } = await extract("103967-2026.pdf", undefined);
	assert.equal(source, "103967-2026.pdf");
});

test("rejects a list with no PDF in it", async () => {
	await assert.rejects(
		() => core.extractPdfText([{ contentUri: `${origin}/x.png`, contentType: "image/png", name: "x.png" }]),
		/No PDF attachment found/,
	);
});

test("rejects an attachment Genesys reports as oversize before downloading it", async () => {
	await assert.rejects(
		() =>
			core.extractPdfText([
				{
					contentLength: core.MAX_ATTACHMENT_BYTES + 1,
					contentType: "application/pdf",
					contentUri: `${origin}/103967-2026.pdf`,
					name: "103967-2026.pdf",
				},
			]),
		/Attachment too large/,
	);
});

/* ------------------------------------------------------ content resolution */

test("a JSON array of attachments is recognised as such", () => {
	const attachment = {
		contentLength: 45991,
		contentType: "application/pdf",
		contentUri: "https://inin-prod-useast1-conversation-services.s3.amazonaws.com/postino/a?X-Amz-Signature=f89",
		id: "19f9b9824f148d185ad3",
		name: "103967-2026.pdf",
	};
	assert.deepEqual(core.asAttachmentList(JSON.stringify([attachment])), [attachment]);
});

test("content that is not an attachment list stays content", () => {
	for (const content of [
		"Hola Juan, tu pedido #4521 está listo.",
		"[esto no es JSON",
		"[]",
		'["a", "b"]', // a JSON array, but not of attachments
		'[{"nombre":"Juan"}]', // objects, but with no contentUri
		'{"contentUri":"https://x/y.pdf"}', // an object, not an array
	]) {
		assert.equal(core.asAttachmentList(content), null, `should not be an attachment list: ${content}`);
	}
});

test("resolveContent downloads when the content is an attachment list", async () => {
	const list = JSON.stringify([
		{ contentType: "application/pdf", contentUri: `${origin}/103967-2026.pdf`, name: "103967-2026.pdf" },
	]);
	const { text, extracted } = await core.resolveContent(list);
	assert.equal(extracted.source, "103967-2026.pdf");
	assert.ok(text.startsWith("REPORTE GENERAL DE SINIESTRO"));
});

test("resolveContent passes text through untouched", async () => {
	const { text, extracted } = await core.resolveContent("Hola Juan");
	assert.equal(text, "Hola Juan");
	assert.equal(extracted, undefined);
});

test("resolveContent needs one of content or attachments", async () => {
	await assert.rejects(() => core.resolveContent(), /content or attachments/);
});

/* -------------------------------------------------- templates: 103967-2026 */

const REPORTE_TEMPLATE = [
	"Impreso: {impreso_fecha} {impreso_hora} Número: {numero} Oficina: {oficina_reporte}",
	"Fecha: {fecha_reporte} Hora: {hora_reporte} Atendió: {atendio} Reportó: {reporto}",
	"Relación: {relacion} Teléfono: {telefono_reporte} Referencia de ingreso: {referencia}",
	"Cliente VIP: {cliente_vip} Vigencia: {vigencia_inicio} - {vigencia_fin} Póliza: {poliza}",
	"Oficina: {oficina_poliza} Inciso: {inciso} Estatus: {estatus_poliza} Módulo: {modulo}",
	"Ramo: {ramo} Subramo: {subramo} Fecha emisión: {fecha_emision} Asegurado: {asegurado}",
	"Cobertura: {cobertura} Estatus inciso: {estatus_inciso} Estatus pago: {estatus_pago}",
	"Forma Pago: {forma_pago} Estatus original al momento de alta del siniestro :",
	"Poliza:{poliza_original}({estatus_poliza_original}) ,Inc:{inciso_original}({estatus_inciso_original})",
	"Agente: {agente} Marca: {marca} Estilo: {estilo} Modelo: {modelo} Color: {color}",
	"Placa: {placa} Serie: {serie} Motor: {motor} Uso: {uso} Tipo: {tipo_vehiculo}",
	"Clave AMIS: {clave_amis} Fecha: {fecha_siniestro} Hora: {hora_siniestro}",
	"Tipo: {tipo_siniestro} Plano: {plano} Estado: {estado} Población: {poblacion}",
	"Ubicación: {ubicacion} Comentario: {comentario} Conductor: {conductor}",
	// authoring rule: always a literal after the last variable, or it goes greedy
	"Teléfono: {telefono_conductor} Ajustadores asignados",
].join(" ");

const REPORTE_EXPECTED = {
	impreso_fecha: "13/07/2026",
	impreso_hora: "12:21",
	numero: "103967/2026",
	oficina_reporte: "005 - QUERETARO",
	fecha_reporte: "13/07/2026",
	hora_reporte: "12:21",
	atendio: "PENTAFON CLARA GABRIELA DOMINGUEZ SOLANO",
	reporto: "PEDRO OSVALDO MONTIEL ORTEGA",
	relacion: "CONDUCTOR",
	telefono_reporte: "4424232966",
	referencia: "103967/26/005/2",
	cliente_vip: "No",
	vigencia_inicio: "01/07/2026",
	vigencia_fin: "01/07/2027",
	poliza: "1011227",
	oficina_poliza: "886 - EMISION CENTRAL LP MONTERREY",
	inciso: "3",
	estatus_poliza: "VIGENTE",
	modulo: "0",
	ramo: "0090",
	subramo: "9202",
	fecha_emision: "25/06/2026",
	asegurado: "PROCESADORA DE ALIMENTOS MEXICANOS SA DE CV",
	cobertura: "LIGEROS INTEGRAL",
	estatus_inciso: "ACT",
	estatus_pago: "ACTIVA",
	forma_pago: "ANUAL",
	poliza_original: "1011227",
	estatus_poliza_original: "ACT",
	inciso_original: "3",
	estatus_inciso_original: "ACT",
	agente: "WILLIS AGENTE DE SEGUROS Y DE FIANZAS 2",
	marca: "FORD",
	estilo: "F-350 K6F SUPER DUTY XL CHASIS CABINA 5.4L GAS LP, 8 CILINDROS, 2 PUERTAS",
	modelo: "2003",
	color: "BLANCO",
	placa: "NA",
	serie: "3FDKF36LX3MB17205",
	motor: "",
	uso: "CARGA MERCANTIL",
	tipo_vehiculo: "CAMION LIGERO",
	clave_amis: "FOB50",
	fecha_siniestro: "13/07/2026",
	hora_siniestro: "12:17",
	tipo_siniestro: "Local",
	plano: "-",
	estado: "QUERÉTARO",
	poblacion: "QUERÉTARO",
	ubicacion: "CALLE Blvd de las Américas COL La Granja ESQ NO TIENE",
	comentario: "S1 COLISION NO HAY LESIONADOS 1078409 COORD 20.57650945104144, -100.40612267547719",
	conductor: "PEDRO OSVALDO MONTIEL ORTEGA",
	telefono_conductor: "4424232966",
};

test("103967-2026.pdf: every field with a single template", async () => {
	const { text } = await extract("103967-2026.pdf");
	const result = core.parseTemplate(REPORTE_TEMPLATE, text, false);
	assert.deepEqual(result, REPORTE_EXPECTED);
	assert.equal(Object.keys(result).length, 52);
});

test("candidates fuzzy-match a value back to the accepted list", async () => {
	const { text } = await extract("103967-2026.pdf");
	const result = core.parseTemplate(REPORTE_TEMPLATE, text, false, {
		// "ANUAL" is within two edits of "ANUALL"
		forma_pago: ["ANUALL", "MENSUAL"],
	});
	assert.equal(result.forma_pago, "ANUALL");
});

/* ------------------------------------------------ templates: 20260710_1119 */

const GS_CASES = [
	{
		template: "Estimado(a) agente: {agente} El dar",
		expected: { agente: "WILLIS AGENTE DE SEGUROS Y DE FIANZAS, S.A. DE C.V." },
	},
	{
		// the table flattens by column, so the template anchors on value shape
		// ("6-") rather than on how the PDF looks
		template: "Asegurado Póliza Siniestro {asegurado} 6-{poliza} 6-{siniestro} Ocurrió",
		expected: {
			asegurado: "ANGEL DE JESUS MUNGARAY VERGARA",
			poliza: "781-1504-13",
			siniestro: "741- 1119-2026",
		},
	},
	{
		// hora and teléfono come out glued together; Architect splits them by
		// substring (fixed HH:MM + 10 digits)
		template: "HoraTeléfono Asegurado {dia} de {mes} de {anio} {hora_tel} Inciso:",
		expected: { dia: "10", mes: "JULIO", anio: "2026", hora_tel: "18:206648124743" },
	},
	{
		template: [
			"Inciso: {inciso} Numero de Serie: {serie} Nombre del Ajustador: {ajustador}",
			"Lugar del Siniestro: {lugar} Descripcion de la Unidad: {unidad}",
			"Tipo de Servicio: {tipo_serv} Numero Economico: {economico}",
			"Nombre del Conductor: {conductor} Descripcion del Siniestro: {desc} Te sugerimos",
		].join(" "),
		expected: {
			inciso: "13",
			serie: "4UZABRDT8ACAN4393",
			ajustador: "ELIEZER SERRATOS FIGUEROA",
			lugar: "CALLE PACIFICO FRE;NTE A PLAZA PACIFICO;22644",
			unidad: "AUTOBUS FREIGHTLINER THOMAS C2",
			tipo_serv: "ACCIDENTE DE TRANSITO",
			economico: "102",
			conductor: "ROGELIO ENRIQUEZ GALVAN",
			desc: "NA CIRCULANDO 3RO HONDA BLANCO SE ATRAVIESA L, PEGA EN LLANTA IMPACTA CN;HONDA BLANCO",
		},
	},
	{
		template: "Estatus {estatus} Registro Sistema GS {registro} General de Seguros",
		expected: { estatus: "PAGADA", registro: "10 de JULIO de 2026" },
	},
	{
		// the block the PDF flattens into one run: the header labels come first and
		// the values after, with hora and teléfono glued together. `{var:regex}`
		// says what each value looks like, so no positional guessing is needed
		template:
			"Asegurado Póliza Siniestro {asegurado:.+?} {poliza:6-[\\d-]+} {siniestro:6-[\\d\\- ]+?} " +
			"Ocurrió HoraTeléfono Asegurado {ocurrio:\\d{1,2} de \\w+ de \\d{4}} " +
			"{hora:\\d{1,2}:\\d{2}}{telefono:\\d{10}} Inciso:",
		expected: {
			asegurado: "ANGEL DE JESUS MUNGARAY VERGARA",
			poliza: "6-781-1504-13",
			siniestro: "6-741- 1119-2026",
			ocurrio: "10 de JULIO de 2026",
			hora: "18:20",
			telefono: "6648124743",
		},
	},
];

for (const [i, { template, expected }] of GS_CASES.entries()) {
	test(`20260710_1119.pdf: template ${i + 1} (${Object.keys(expected).join(", ")})`, async () => {
		const { text } = await extract("20260710_1119.pdf");
		assert.deepEqual(core.parseTemplate(template, text, false), expected);
	});
}

test("{...} skips intermediate text so a variable does not eat a paragraph", async () => {
	const { text } = await extract("103967-2026.pdf");
	assert.deepEqual(
		core.parseTemplate("Forma Pago: {forma_pago} Estatus original{...}Agente: {agente} Marca:", text, false),
		{ forma_pago: "ANUAL", agente: "WILLIS AGENTE DE SEGUROS Y DE FIANZAS 2" },
	);
});

/* ------------------------------------------------- templates: {var:regex} */

test("{var:regex} splits values the PDF glued together", () => {
	assert.deepEqual(core.parseTemplate("Hora {hora:\\d{2}:\\d{2}}{tel:\\d{10}} fin", "Hora 18:206648124743 fin", false), {
		hora: "18:20",
		tel: "6648124743",
	});
});

test("{var:regex} captures a value with spaces in it", () => {
	assert.deepEqual(
		core.parseTemplate("Siniestro {siniestro:6-[\\d\\- ]+?} Ocurrió", "Siniestro 6-741- 1119-2026 Ocurrió", false),
		{ siniestro: "6-741- 1119-2026" },
	);
});

test("{var:regex} mixes with plain vars and optional sections", () => {
	assert.deepEqual(
		core.parseTemplate("Póliza {poliza:[\\d-]+} Agente: {agente}[ Oficina: {oficina}] fin", "Póliza 781-1504 Agente: WILLIS fin", false),
		{ poliza: "781-1504", agente: "WILLIS", oficina: "" },
	);
});

test("a {var:regex} that does not match fails like any other template", () => {
	assert.throws(() => core.parseTemplate("Teléfono {tel:\\d{10}} fin", "Teléfono 664 fin", false), /does not match/);
});

test("a malformed {var:regex} is reported by name", () => {
	assert.throws(() => core.buildPattern("Hora {hora:\\d{2}:(} fin"), /Invalid regex for variable "hora"/);
	assert.throws(() => core.buildPattern("Hora {hora:} fin"), /Empty regex for variable "hora"/);
	assert.throws(() => core.buildPattern("Hora {hora:\\d+ fin"), /missing closing '}'/);
});

test("a literal colon after a variable is still a plain variable", () => {
	assert.deepEqual(core.parseTemplate("Inciso {inciso}: fin", "Inciso 13: fin", false), { inciso: "13" });
});

test("a template that does not match reports the content it saw", async () => {
	const { text } = await extract("103967-2026.pdf");
	assert.throws(
		() => core.parseTemplate("No aparece en el documento: {x} fin", text, false),
		/does not match/,
	);
});
