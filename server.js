import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = express();
app.use(express.json({ limit: '200mb' }));

// Multer para recibir multipart (desde n8n, Postman, etc.)
const upload = multer({ dest: '/tmp' });

// Salud para Railway
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/**
 * POST /import
 * Modo A (JSON):
 * {
 *   "sourceUrl": "https://.../archivo.gml|zip|gpkg|geojson",
 *   "table": "parcelas_muros",
 *   "srid": 25830,
 *   "promoteToMulti": true,
 *   "layerName": "nombre_capa" // opcional
 * }
 *
 * Modo B (multipart):
 * - Campo binario: "data" (n8n) o "file" (Postman)
 * - Campos de texto: table, srid, promoteToMulti, layerName
 */
app.post('/import', upload.any(), async (req, res) => {
  const cleanup = (p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(_){} };

  try {
    // ---- Credenciales PG desde entorno (Railway Variables) ----
    const PGHOST = process.env.PGHOST;
    const PGPORT = process.env.PGPORT || '5432';
    const PGDATABASE = process.env.PGDATABASE;
    const PGUSER = process.env.PGUSER;
    const PGPASSWORD = process.env.PGPASSWORD;

    if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD) {
      return res.status(500).json({ error: 'Faltan variables de entorno PG*' });
    }

    // ---- Parámetros (cuerpo JSON o form-data) ----
    const body = req.body || {};
    let {
      sourceUrl,
      table = 'parcelas_muros',
      srid = 25830,
      promoteToMulti = 'true',
      layerName
    } = body;

    // n8n manda booleans como texto en form-data
    if (typeof promoteToMulti !== 'boolean') {
      promoteToMulti = String(promoteToMulti).toLowerCase() === 'true';
    }
    if (typeof srid === 'string') srid = parseInt(srid, 10);

    // ---- Origen del archivo: JSON (descarga) o multipart (archivo subido) ----
    let localPath; // ruta en /tmp
    let removeLocalAfter = false;

    // ¿Viene binario? (n8n -> Binary Property "data" o "file")
    let filePart = (req.files || []).find(f => f.fieldname === 'data') ||
                   (req.files || []).find(f => f.fieldname === 'file');

    if (filePart) {
      localPath = filePart.path;                // ya está en /tmp
    } else if (sourceUrl) {
      // descarga a /tmp conservando nombre/extension si es posible
      const tmpDir = path.join(os.tmpdir(), 'gdal');
      fs.mkdirSync(tmpDir, { recursive: true });
      const rawName = path.basename((sourceUrl.split('?')[0] || '').split('#')[0]) || 'file.gml';
      localPath = path.join(tmpDir, rawName);

      const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', maxRedirects: 5, timeout: 120000 });
      fs.writeFileSync(localPath, resp.data);
      removeLocalAfter = true;
    } else {
      return res.status(400).json({ error: 'Debes enviar "sourceUrl" (JSON) o un archivo binario (campo "data" o "file")' });
    }

    // ---- Preparar ruta para GDAL ----
    const ext = path.extname(localPath).toLowerCase();
    const isZip = ext === '.zip';
    const sourceForOgr = isZip ? `/vsizip/${localPath}` : localPath;

    // Si la fuente tiene varias capas y quieres seleccionar una
    const layerArg = layerName ? `"${layerName}"` : '';

    // Promover a MULTI
    const promoteArg = promoteToMulti ? '-nlt PROMOTE_TO_MULTI' : '';

    // Conexión PG
    const conn = `PG:"host=${PGHOST} port=${PGPORT} dbname=${PGDATABASE} user=${PGUSER} password='${PGPASSWORD}'"`;

    // Comando ogr2ogr
    // -lco GEOMETRY_NAME=geom   => nombre de la columna geom
    // -overwrite                 => sobreescribe la tabla
    // -t_srs EPSG:<srid>         => reproyecta a SRID destino
    // Si layerName está definido, se añade al final para elegir la capa fuente
    const cmd =
      `ogr2ogr -f "PostgreSQL" ${conn} "${sourceForOgr}" ${layerArg} ` +
      `-nln ${table} -lco GEOMETRY_NAME=geom ${promoteArg} -t_srs EPSG:${srid} -overwrite -progress`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      // Limpieza del temporal descargado (si no venía subido)
      if (removeLocalAfter) cleanup(localPath);
      if (err) {
        // si GDAL imprime en stderr aunque no falle, devolvemos ambos
        return res.status(500).json({
          error: 'ogr2ogr failed',
          stderr: String(stderr || ''),
          stdout: String(stdout || ''),
          cmd
        });
      }
      return res.json({
        ok: true,
        cmd,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || 'error' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`GDAL Worker listening on ${PORT}`));
