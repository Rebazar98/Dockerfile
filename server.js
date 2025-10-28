import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = express();

// --- Middlewares base ---
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// Log de cada request (para cazar 404/405 fácilmente)
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

// Listar rutas registradas (debug)
app.get('/routes', (_req, res) => {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route && m.route.path) {
      routes.push({ methods: m.route.methods, path: m.route.path });
    }
  });
  res.json(routes);
});

// Salud
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Multer tmp
const upload = multer({ dest: '/tmp' });

// /import solo acepta POST (si llega GET/OPTIONS devolver 405)
app.all('/import', (req, res, next) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed', method: req.method });
  }
  return next();
});

// /import con logs detallados (cmd, stdout, stderr)
app.post('/import', upload.any(), async (req, res) => {
  const cleanup = (p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} };

  try {
    // --- ENV PG ---
    const { PGHOST, PGPORT = '5432', PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE } = process.env;
    if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD) {
      return res.status(500).json({ error: 'Faltan variables PG* en entorno' });
    }
    const ssl = PGSSLMODE ? ` sslmode=${PGSSLMODE}` : '';
    const conn = `PG:"host=${PGHOST} port=${PGPORT} dbname=${PGDATABASE} user=${PGUSER} password='${PGPASSWORD}'${ssl}"`;

    // --- Params ---
    const b = req.body || {};
    let {
      sourceUrl,
      table = 'parcelas_muros',
      srid = 25830,
      promoteToMulti = 'true',
      layerName,
    } = b;

    if (typeof promoteToMulti !== 'boolean') {
      promoteToMulti = String(promoteToMulti).toLowerCase() === 'true';
    }
    if (typeof srid === 'string') srid = parseInt(srid, 10);

    // --- Origen: binario (n8n) o URL ---
    let localPath; let removeLocalAfter = false;
    const filePart =
      (req.files || []).find((f) => f.fieldname === 'data') ||
      (req.files || []).find((f) => f.fieldname === 'file');

    if (filePart) {
      localPath = filePart.path;
      console.log(
        `[import] Binario recibido: ${filePart.originalname} ${filePart.mimetype} ${filePart.size}B`,
      );
    } else if (sourceUrl) {
      const tmpDir = path.join(os.tmpdir(), 'gdal');
      fs.mkdirSync(tmpDir, { recursive: true });
      const rawName = path.basename((sourceUrl.split('?')[0] || '').split('#')[0]) || 'file.gml';
      localPath = path.join(tmpDir, rawName);
      console.log('[import] Descargando', sourceUrl);
      const resp = await axios.get(sourceUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 120000,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const ct = resp.headers['content-type'] || '';
      if (ct.includes('text/html')) {
        return res
          .status(400)
          .json({ error: 'La URL devuelve HTML (login/antivirus). Envía el archivo como binario.' });
      }
      fs.writeFileSync(localPath, resp.data);
      removeLocalAfter = true;
      console.log(`[import] Guardado en ${localPath} (${resp.data.length}B) CT=${ct}`);
    } else {
      return res
        .status(400)
        .json({ error: 'Envía "sourceUrl" o un archivo (campo "data"/"file")' });
    }

    // --- Fuente para GDAL ---
    const ext = path.extname(localPath).toLowerCase();
    const srcForOgr = ext === '.zip' ? `/vsizip/${localPath}` : localPath;
    const layerArg = layerName ? `"${layerName}"` : '';
    const promoteArg = promoteToMulti ? '-nlt PROMOTE_TO_MULTI' : '';

    // ¿La capa trae SRS?
    const checkCmd = `ogrinfo -ro -so -al "${srcForOgr}" ${layerArg}`;
    let hasSRS = false;
    try {
      const info = await new Promise((ok) =>
        exec(checkCmd, { maxBuffer: 16 * 1024 * 1024 }, (_e, out = '') => ok(String(out))),
      );
      hasSRS = /Layer SRS WKT|PROJCS|GEOGCS|EPSG/.test(info);
    } catch (_) {}

    const srsAssign = hasSRS ? '' : `-a_srs EPSG:${srid}`;
    const reproject = `-t_srs EPSG:${srid}`;

    const cmd =
      `ogr2ogr -f "PostgreSQL" ${conn} "${srcForOgr}" ${layerArg} ` +
      `-nln ${table} -lco GEOMETRY_NAME=geom ${promoteArg} ${srsAssign} ${reproject} -overwrite -progress`;

    console.log('[import] CMD =>', cmd);

    exec(
      cmd,
      { maxBuffer: 64 * 1024 * 1024, timeout: 180000 },
      (err, stdout, stderr) => {
        if (removeLocalAfter) cleanup(localPath);
        const payload = {
          ok: !err,
          cmd,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        };
        if (err) {
          console.error('[ogr2ogr:error]', payload.stderr || payload.stdout);
          return res.status(500).json({ error: 'ogr2ogr failed', ...payload });
        }
        return res.json(payload);
      },
    );
  } catch (e) {
    console.error('[import:catch]', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`GDAL Worker listening on ${PORT}`));
