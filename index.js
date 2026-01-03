import fs from "fs";

function isProbablyBase64(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (t.startsWith("{")) return false;
  // base64 típico: letras/números + + / = (y a veces - _)
  return /^[A-Za-z0-9+/=_-]+$/.test(t) && t.length > 40;
}

function normalizeB64(input) {
  let clean = String(input)
    .trim()
    .replace(/^["']|["']$/g, "")      // quita comillas si Render las agrega
    .replace(/[\r\n\t\s]+/g, "")      // quita saltos/espacios
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (clean.length % 4 !== 0) clean += "=";
  return clean;
}

function decodeB64ToUtf8(b64) {
  const clean = normalizeB64(b64);
  return Buffer.from(clean, "base64").toString("utf8").trim();
}

function loadServiceAccount() {
  // Opción A: archivo (Render Secret File o repo privado)
  const keyFile = process.env.GOOGLE_KEY_FILE;
  if (keyFile) {
    if (!fs.existsSync(keyFile)) {
      throw new Error(
        `No encuentro el archivo de service account en: ${keyFile}`
      );
    }
    const raw = fs.readFileSync(keyFile, "utf8").trim();
    const json = JSON.parse(raw);
    if (!json.client_email || !json.private_key) {
      throw new Error("El archivo existe pero NO es un service account válido");
    }
    return json;
  }

  // Opción B: JSON directo en env (sin base64)
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawJson && rawJson.trim().startsWith("{")) {
    const json = JSON.parse(rawJson.trim());
    if (!json.client_email || !json.private_key) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON no es un service account válido");
    }
    return json;
  }

  // Opción C: base64 en env
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) {
    throw new Error(
      "Faltan credenciales. Usá GOOGLE_KEY_FILE o GOOGLE_SERVICE_ACCOUNT_JSON o GOOGLE_SERVICE_ACCOUNT_B64"
    );
  }

  // 1) decode normal
  let decoded = decodeB64ToUtf8(b64);

  // 2) si decodifica a OTRA base64 (pasa mucho con páginas), lo decodifico de nuevo
  if (!decoded.startsWith("{") && isProbablyBase64(decoded)) {
    decoded = decodeB64ToUtf8(decoded);
  }

  // 3) limpieza final
  decoded = decoded.replace(/^\uFEFF/, "").trim(); // quita BOM si aparece

  if (!decoded.startsWith("{")) {
    // muestro preview para depurar sin exponer secretos
    const preview = decoded.slice(0, 25).replace(/[^\x20-\x7E]/g, "?");
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON. Preview: ${preview}`
    );
  }

  const json = JSON.parse(decoded);
  if (!json.client_email || !json.private_key) {
    throw new Error("El JSON decodificado NO es un service account válido");
  }

  return json;
}

// ====== START (acá arranca tu app real) ======
try {
  const sa = loadServiceAccount();
  console.log("✅ Service Account OK:", sa.client_email);

  // >>> Acá va tu código real del bot / sheets / etc.
  // IMPORTANTE: no logs de private_key, nunca.

} catch (e) {
  console.error("❌ FATAL:", e.message);
  process.exit(1);
}
