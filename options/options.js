import { loadConfig, saveConfig } from '../lib/config.js';

const form = document.getElementById('config-form');
const statusEl = document.getElementById('status');
const fields = {
  portalOrigin: document.getElementById('portalOrigin'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  baseUrl: document.getElementById('baseUrl'),
  otpPeriod: document.getElementById('otpPeriod'),
  otpInputSelector: document.getElementById('otpInputSelector'),
};

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `status ${kind || ''}`;
}

/** Convierte una URL en un patrón de origen, p. ej. "https://host:8063/*". */
function toOriginPattern(rawUrl) {
  const url = new URL(rawUrl); // lanza excepción si la URL no es válida
  return `${url.protocol}//${url.host}/*`;
}

async function restore() {
  const config = await loadConfig();
  fields.portalOrigin.value = config.portalOrigin
    ? config.portalOrigin.replace(/\/\*$/, '')
    : '';
  fields.username.value = config.username;
  fields.password.value = config.password;
  fields.baseUrl.value = config.baseUrl;
  fields.otpPeriod.value = config.otpPeriod;
  fields.otpInputSelector.value = config.otpInputSelector;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('Guardando…', '');

  let portalPattern;
  let baseUrl;
  try {
    portalPattern = toOriginPattern(fields.portalOrigin.value.trim());
    baseUrl = fields.baseUrl.value.trim();
    new URL(baseUrl); // valida: lanza excepción si está vacía o mal formada
  } catch {
    setStatus('URL inválida. Usa el formato https://host', 'err');
    return;
  }

  // Un selector inválido fallaría dentro de la página, donde el error no se ve.
  const otpInputSelector = fields.otpInputSelector.value.trim();
  if (otpInputSelector) {
    try {
      document.createDocumentFragment().querySelector(otpInputSelector);
    } catch {
      setStatus('El selector CSS del campo no es válido.', 'err');
      return;
    }
  }

  const origins = [portalPattern, toOriginPattern(baseUrl)];
  let granted;
  try {
    granted = await chrome.permissions.request({ origins });
  } catch (err) {
    setStatus(`No se pudo solicitar permiso: ${err.message}`, 'err');
    return;
  }
  if (!granted) {
    setStatus('Permiso denegado. Concede el acceso para poder leer el portal.', 'err');
    return;
  }

  await saveConfig({
    portalOrigin: portalPattern,
    username: fields.username.value.trim(),
    password: fields.password.value,
    baseUrl,
    otpPeriod: Number(fields.otpPeriod.value) || undefined,
    otpInputSelector,
  });
  setStatus('✓ Guardado', 'ok');
});

restore();
