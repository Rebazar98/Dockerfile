import express from 'express';
import { exec } from 'child_process';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json({ limit: '200mb' }));

// Salud para Railway
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// POST /import
// Body JSON:
// {
//   "sourceUrl": "https://.../Gml1_Muros_de_Nalon.gml"  (o ZIP con SHP)
//   "table": "parcelas_muros",
//   "srid": 25830,                // opcional (por defecto 25830)
//   "promoteToMulti": true        // opcional
// }
app.post('/import', async (req, res) => {
  try {
    const {
      sourceUrl,
      table = 'parcelas_muros',
      srid = 25830,
      promoteToMulti = true,
      layerName // opcional: si el ZIP trae varias capas y quieres forzar una
    } = req.body || {};

    if (!sourceUrl) {
      return res.status(400).json({ error: 'Falta sourceUrl' });
    }

    // Vars de conexión (ponlas en Railway como envs)
    const PGHOST = process.env.PGHOST;
    const PGPORT = process.env.PGPORT || '5432';
    const PGDATABASE = process.env.PGDATABASE;
    const PGUSER = process.env.PGUSER;
    const PGPASSWORD = process.env.PGPASSWORD;

    if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD) {
      return res.status(500).json({ error: 'Faltan variables PG* en entorno' });
    }

    // Descargar al /tmp
    const tmpDir = '/tmp/gdal';
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, path.basename(sourceUrl.split('?')[0]) || 'file.gml');

    const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(target, resp.data);

    // Construir comando ogr2ogr
    // Para ZIP con SHP o GML funciona igual.
    const promote = promoteToMulti ? '-nlt PROMOTE_TO_MULTI' : '';
    const layerOpt = layerName ? `-nlt ${layerName}` : ''; // solo si quieres forzar layer type
    const conn = `PG:"host=${PGHOST} port=${PGPORT} dbname=${PGDATABASE} user=${PGUSER} password='${PGPASSWORD}'"`;

    const cmd =
      `ogr2ogr -f "PostgreSQL" ${conn} "${target}" ` +
      `-nln ${table} -lco GEOMETRY_NAME=geom ${promote} -t_srs EPSG:${srid} -overwrite -progress`;

    // Ejecutar
    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr || stdout);
        return res.status(500).json({ error: 'ogr2ogr failed', details: (stderr || stdout).toString() });
      }
      return res.json({ ok: true, stdout: stdout.toString() });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'error' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`GDAL Worker listening on ${PORT}`));
