// ==== EzerBot API JSON (Config + Catalogo) ====
// Lee tu Spreadsheet tal cual está (sin modificar Sheets)

// ✅ TU SPREADSHEET ID:
const SPREADSHEET_ID = '1OchBepfJpdKNi-FeiEy1JaXtiwGWi40JgSnzplqtuk0';

// ✅ Nombres de hojas:
const CONFIG_SHEET_NAME = 'Config';
const CATALOG_SHEET_NAME = 'Catalogo';

function doGet(e) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  const typeRaw = (e && e.parameter && e.parameter.type) ? String(e.parameter.type) : '';
  const type = typeRaw.trim().toLowerCase();

  let payload;
  if (type === 'config') payload = getConfig(ss);
  else if (type === 'catalog' || type === 'catalogo') payload = getCatalog(ss);
  else payload = { ok: true, endpoints: { config: '?type=config', catalog: '?type=catalog' } };

  return ContentService
    .createTextOutput(JSON.stringify(payload, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- CONFIG: hoja con columnas KEY / VALUE ----
function getConfig(ss) {
  const sh = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sh) return { error: 'Hoja Config no encontrada' };

  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return { error: 'Hoja Config sin datos' };

  const headers = values[0].map(h => String(h || '').trim().toUpperCase());
  const keyIndex = headers.indexOf('KEY');
  const valueIndex = headers.indexOf('VALUE');

  if (keyIndex === -1 || valueIndex === -1) {
    return { error: 'Config debe tener encabezados KEY y VALUE (tal cual)' };
  }

  const obj = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const k = String(row[keyIndex] || '').trim();
    if (!k) continue;
    obj[k] = row[valueIndex];
  }

  return obj;
}

// ---- CATALOGO: hoja con columnas como tu foto ----
// CODIGO | NOMBRE | PRECIO | UNIDAD | PRECIOPORKILO | CODIGOBARRAS | DESCRIPCION | IMAGEN | CATEGORIA
function getCatalog(ss) {
  const sh = ss.getSheetByName(CATALOG_SHEET_NAME);
  if (!sh) return { error: 'Hoja Catalogo no encontrada' };

  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return [];

  const headers = values[0].map(h => String(h || '').trim().toUpperCase());

  const idxCodigo = headers.indexOf('CODIGO');
  const idxNombre = headers.indexOf('NOMBRE');
  const idxPrecio = headers.indexOf('PRECIO');
  const idxUnidad = headers.indexOf('UNIDAD');
  const idxPrecioKg = headers.indexOf('PRECIOPORKILO');
  const idxBarras = headers.indexOf('CODIGOBARRAS');
  const idxDesc = headers.indexOf('DESCRIPCION');
  const idxImg = headers.indexOf('IMAGEN');
  const idxCat = headers.indexOf('CATEGORIA');

  const out = [];

  for (let i = 1; i < values.length; i++) {
    const r = values[i];

    const codigo = idxCodigo === -1 ? '' : String(r[idxCodigo] || '').trim();
    const nombre = idxNombre === -1 ? '' : String(r[idxNombre] || '').trim();
    if (!nombre) continue;

    const precio = idxPrecio === -1 ? 0 : Number(r[idxPrecio] || 0);
    const unidad = idxUnidad === -1 ? '' : String(r[idxUnidad] || '').trim().toLowerCase(); // "kg" o "unidad"
    const precioPorKilo = idxPrecioKg === -1 ? 0 : Number(r[idxPrecioKg] || 0);
    const codigoBarras = idxBarras === -1 ? '' : String(r[idxBarras] || '').trim();
    const descripcion = idxDesc === -1 ? '' : String(r[idxDesc] || '').trim();
    const imagenUrl = idxImg === -1 ? '' : String(r[idxImg] || '').trim();
    const categoria = idxCat === -1 ? '' : String(r[idxCat] || '').trim();

    out.push({
      id: codigo || nombre,
      codigo,
      nombre,
      precio,
      unidad,
      precioPorKilo,
      codigoBarras,
      descripcion,
      imagenUrl,
      categoria,
      activo: true
    });
  }

  return out;
                     } 
