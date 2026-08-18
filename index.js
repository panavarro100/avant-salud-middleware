'use strict';
const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const BASE = process.env.AVANT_BASE || 'http://181.66.254.26:8020/avantsalud';
const AVANT_USER = process.env.AVANT_USER || 'YUDITH.VALENCIA.HUANACO';
const AVANT_PASS = process.env.AVANT_PASS || '';
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Session manager
let jar = new CookieJar();
let client = wrapper(axios.create({ jar, withCredentials: true, baseURL: BASE }));
let sessionActive = false;

async function login() {
  const fd = new FormData();
  fd.append('usuario', AVANT_USER);
  fd.append('password', AVANT_PASS);
  const res = await client.post('/', fd, { headers: fd.getHeaders(), maxRedirects: 5 });
  sessionActive = res.status === 200;
  console.log('[Avant] Login', sessionActive ? 'OK' : 'FAIL');
  return sessionActive;
}

async function ensureSession() {
  if (!sessionActive) await login();
}

async function findOrCreatePatient(data) {
  await ensureSession();
  // Try to find existing patient by DNI
  try {
    const r = await client.get('/Admision/Filiaciones/apiPaciente/' + data.dni);
    if (r.data && r.data.id) return r.data.id;
  } catch(e) { /* not found or no permission */ }

  // Create new patient
  const fd = new FormData();
  fd.append('accion', 'insert');
  fd.append('apePaterno', data.apellidoPaterno || '');
  fd.append('apeMaterno', data.apellidoMaterno || '');
  fd.append('nombres', data.nombres || '');
  fd.append('tipoDoc', '1');
  fd.append('numDoc', data.dni || '');
  fd.append('fecNac', data.fechaNac || '01-01-1990');
  fd.append('sexo', data.sexo || 'M');
  fd.append('celular', data.celular || '');
  fd.append('idEmpresa', data.idEmpresa || '835');
  const res = await client.post('/Admision/Filiaciones/ejecutarCrud', fd, { headers: fd.getHeaders() });
  if (res.data && res.data.estado === 'success') return res.data.id;
  throw new Error('No se pudo crear paciente: ' + JSON.stringify(res.data));
}

async function loadProtocol(idempresa, idperfil, sexo, edad) {
  await ensureSession();
  const res = await client.get('/Administracion/Protocolo/buscprot', {
    params: { idempresa, idperfil, idtipo: 1, sexo, edad, idtipo_formato: 312 }
  });
  return res.data;
}

async function createOrder(data, pacienteId, examenes) {
  await ensureSession();
  const fd = new FormData();
  fd.append('accion', 'insert');
  fd.append('idPaciente', pacienteId);
  fd.append('idEmpresa', data.idEmpresa || '835');
  fd.append('idPerfil', data.idPerfil || '730');
  fd.append('fechaOrden', data.fechaOrden || new Date().toISOString().slice(0,10));
  fd.append('examenes', JSON.stringify(examenes));
  const res = await client.post('/Admision/OrdenOcup/ejecutarCrud', fd, { headers: fd.getHeaders() });
  return res.data;
}

// CRM Webhook endpoint
app.post('/webhook/crm', async (req, res) => {
  try {
    if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET)
      return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body;
    console.log('[Webhook] Recibido:', JSON.stringify(body).slice(0, 200));

    const pacienteId = await findOrCreatePatient(body);
    console.log('[Avant] Paciente ID:', pacienteId);

    const prot = await loadProtocol(body.idEmpresa || 835, body.idPerfil || 730, body.sexo || 'M', body.edad || 30);
    console.log('[Avant] Examenes:', prot.length || 0);

    const orden = await createOrder(body, pacienteId, prot);
    console.log('[Avant] Orden:', orden.codigo);

    res.json({ success: true, pacienteId, ordenCodigo: orden.codigo });
  } catch (err) {
    console.error('[Error]', err.message);
    if (!sessionActive) { sessionActive = false; }
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', session: sessionActive }));

app.listen(PORT, async () => {
  console.log('[Server] Puerto:', PORT);
  await login();
});
