// Flujo de red contra el sitio OTP. Se ejecuta en el service worker.
// El navegador adjunta las cookies de sesión y antiforgery automáticamente
// gracias al permiso de host sobre el origen.

import {
  parseAntiforgeryToken,
  isLoginPage,
  parseDeviceTable,
  parseOtpResult,
} from './parsers.js';

/** Peticiones de OTP simultáneas como máximo. */
const OTP_CONCURRENCY = 4;

/** Desfase de reloj máximo aceptable; por encima, la lectura se descarta. */
const MAX_PLAUSIBLE_OFFSET_MS = 120 * 1000;

/** Tiempo máximo por petición antes de abortarla. */
const REQUEST_TIMEOUT_MS = 15000;

const LOG_PREFIX = '[OTP]';
const log = (...args) => console.info(LOG_PREFIX, ...args);

/** Quita parámetros y credenciales de una URL antes de mostrarla. */
function safeUrlForMessage(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[URL no válida]';
  }
}

/**
 * Última lectura del reloj del servidor, tomada de la cabecera `Date`.
 * @type {{offsetMs:number, observedAt:number}|null}
 */
let clockObservation = null;

/** Lectura más reciente del reloj del servidor, o null si no hay ninguna. */
export function getClockObservation() {
  return clockObservation;
}

/** Restaura la lectura tras un reinicio del service worker. */
export function restoreClockObservation(saved) {
  if (isClockSyncFresh(saved)) clockObservation = saved;
}

/** Registra el desfase con el servidor a partir de la cabecera `Date`. */
function noteServerClock(response, sentAt) {
  const header = response.headers.get('date');
  if (!header) return;

  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) return;

  // El punto medio de la ida y vuelta es el instante del cliente que mejor
  // se corresponde con el momento en que el servidor selló la respuesta.
  const clientMs = (sentAt + Date.now()) / 2;
  const offsetMs = serverMs - clientMs;

  if (Math.abs(offsetMs) > MAX_PLAUSIBLE_OFFSET_MS) {
    log(`Cabecera Date con desfase implausible (${Math.round(offsetMs / 1000)}s); se ignora.`);
    return;
  }

  clockObservation = { offsetMs, observedAt: Date.now() };
}

/** Error con un código legible por el popup para distinguir cada caso. */
export class OtpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OtpError';
    this.code = code;
  }
}

/**
 * Lanza una petición sin seguir redirecciones. Un 3xx llega como respuesta
 * opaca (status 0), suficiente para saber que nos mandaron al login.
 */
async function request(url, options = {}) {
  let response;
  const sentAt = Date.now();
  try {
    response = await fetch(url, {
      credentials: 'include',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...options,
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new OtpError(
      timedOut ? 'TIMEOUT' : 'NETWORK',
      timedOut
        ? `El sitio OTP no respondió en ${Math.round(REQUEST_TIMEOUT_MS / 1000)} s (${safeUrlForMessage(url)}).`
        : `No se pudo conectar con el sitio OTP (${safeUrlForMessage(url)}). ¿Está activo y accesible? Detalle: ${err.message}`,
    );
  }

  noteServerClock(response, sentAt);

  const redirected =
    response.type === 'opaqueredirect' ||
    response.status === 0 ||
    (response.status >= 300 && response.status < 400);

  // Una redirección opaca no tiene cuerpo legible; no se intenta leer.
  const html = redirected ? '' : await response.text();

  log(`${options.method || 'GET'} request -> ${redirected ? '3xx (no seguido)' : response.status}`,
      `bytes=${html.length}`);
  return { response, html, redirected };
}

/** Indica si la respuesta a una página protegida significa "sin sesión". */
function looksUnauthenticated({ response, html, redirected }) {
  if (redirected) return true;
  if (response.status === 401 || response.status === 403) return true;
  return isLoginPage(html);
}

/** Inicia sesión con las credenciales configuradas. */
async function login(baseUrl, username, password) {
  log('Autenticando…');
  const { html: loginHtml } = await request(`${baseUrl}/Home/Login`);
  const token = parseAntiforgeryToken(loginHtml);
  if (!token) {
    throw new OtpError(
      'NO_TOKEN',
      'No se encontró el __RequestVerificationToken en la página de login.',
    );
  }

  const body = new URLSearchParams();
  body.set('UserName', username);
  body.set('Password', password);
  body.set('__RequestVerificationToken', token);

  // El servidor caduca la sesión a los 30 minutos exactos con independencia de
  // este campo, así que no se pide cookie persistente.
  body.set('RememberMe', 'false');

  const result = await request(`${baseUrl}/Home/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  // 302 => autenticado. Formulario de login de vuelta => credenciales malas.
  if (!result.redirected && isLoginPage(result.html)) {
    throw new OtpError(
      'BAD_CREDENTIALS',
      'Inicio de sesión fallido. Revisa el usuario y la contraseña en Opciones.',
    );
  }
  log('Autenticación correcta.');
}

/**
 * Consulta los dispositivos de una identificación, autenticando si hace falta.
 * La primera petición hace de sondeo: con sesión viva ya trae los datos.
 */
async function fetchDevices(baseUrl, identification, username, password) {
  const url = `${baseUrl}/DeviceTokens?userr=${encodeURIComponent(identification)}&currentpage=1&rowss=50`;

  const probe = await request(url);
  if (!looksUnauthenticated(probe)) {
    const devices = parseDeviceTable(probe.html);
    log(`Dispositivos encontrados: ${devices.length}`);
    return devices;
  }

  log('Sesión expirada; iniciando login…');
  await login(baseUrl, username, password);

  const result = await request(url);
  if (looksUnauthenticated(result)) {
    throw new OtpError(
      'BAD_CREDENTIALS',
      'No fue posible autenticarse en el sitio OTP tras iniciar sesión.',
    );
  }

  const devices = parseDeviceTable(result.html);
  log(`Dispositivos encontrados: ${devices.length}`);
  return devices;
}

/** Consulta el OTP de un dispositivo por su testId. */
async function fetchOtp(baseUrl, testId) {
  const result = await request(`${baseUrl}/DeviceTokens/Test/${encodeURIComponent(testId)}`);
  if (looksUnauthenticated(result)) {
    throw new OtpError('SESSION_LOST', 'La sesión expiró al consultar el OTP.');
  }
  return parseOtpResult(result.html);
}

/** Vigencia de una lectura del reloj del servidor. */
export const CLOCK_SYNC_TTL_MS = 10 * 60 * 1000;

/** Indica si una lectura del reloj sigue siendo utilizable. */
export function isClockSyncFresh(cached, now = Date.now()) {
  return Boolean(
    cached &&
      Number.isFinite(cached.observedAt) &&
      Number.isFinite(cached.offsetMs) &&
      now - cached.observedAt >= 0 &&
      now - cached.observedAt < CLOCK_SYNC_TTL_MS,
  );
}

/**
 * Instante, en reloj del cliente, en que termina la ventana OTP actual.
 * Los códigos cambian en fronteras absolutas de `periodSeconds` compartidas
 * por todos los dispositivos, así que caducan todos a la vez.
 */
export function computeWindowEnd(periodSeconds, offsetMs = 0, now = Date.now()) {
  const periodMs = periodSeconds * 1000;
  const serverNow = now + offsetMs;
  const serverEnd = Math.floor(serverNow / periodMs) * periodMs + periodMs;
  return serverEnd - offsetMs; // de vuelta al reloj del cliente
}

/**
 * Relee el OTP de dispositivos ya conocidos, sin repetir la consulta de la
 * tabla. Lo usa el refresco automático al caducar un código.
 */
export async function getOtpsForDevices(config, devices) {
  const { baseUrl, username, password } = config;

  // Las consultas van en paralelo: compartir la promesa del login hace que
  // todas esperen a la misma reautenticación si la sesión cae.
  let loginPromise = null;
  const reauthenticate = () => {
    if (!loginPromise) {
      log('Sesión perdida durante el refresco automático; reautenticando…');
      loginPromise = login(baseUrl, username, password);
    }
    return loginPromise;
  };

  const fetchOne = async (device) => {
    try {
      return await fetchOtp(baseUrl, device.testId);
    } catch (err) {
      if (err instanceof OtpError && err.code === 'SESSION_LOST') {
        await reauthenticate();
        return fetchOtp(baseUrl, device.testId); // un único reintento
      }
      throw err;
    }
  };

  return mapWithConcurrency(devices, OTP_CONCURRENCY, async (device) => {
    let otpData = { serial: null, otp: null, raw: '' };
    try {
      otpData = (await fetchOne(device)) || otpData;
    } catch (err) {
      otpData = { serial: null, otp: null, raw: '', error: err.message };
    }
    log('Consulta OTP completada.');
    return { ...device, ...otpData };
  });
}

/** Ejecuta `task` sobre `items` con `limit` en vuelo, conservando el orden. */
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Tabla de dispositivos de una identificación, sin sus OTP. Va aparte para que
 * el llamante descarte filas antes de pagar una petición de OTP por cada una.
 * @returns {Promise<Array<{deviceId,targetUser,state,account,application,testId}>>}
 */
export async function getDevicesForIdentification(config, identification) {
  const { baseUrl, username, password } = config;
  return fetchDevices(baseUrl, identification, username, password);
}
