// Orquesta la consulta: lee la identificación del sessionStorage de la pestaña
// del portal y consulta los OTP en el sitio de administración de tokens.

import { loadConfig, isConfigComplete } from '../lib/config.js';
import { resolveUserType, selectDevicesForUser } from '../lib/device-selection.js';
import {
  getDevicesForIdentification,
  getOtpsForDevices,
  computeWindowEnd,
  isClockSyncFresh,
  getClockObservation,
  restoreClockObservation,
  OtpError,
} from '../lib/alianza-client.js';

/** Se inyecta en la pestaña del portal para leer sessionStorage['userData']. */
function readUserDataFromPage() {
  try {
    const raw = sessionStorage.getItem('userData');
    if (!raw) return { ok: false, reason: 'NO_USERDATA' };
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, reason: 'PARSE_ERROR', message: err.message };
  }
}

/**
 * Se inyecta en la pestaña del portal para escribir el código. Si el selector
 * coincide con un campo, recibe el código completo; si coincide con varios
 * —un grupo de casillas de un dígito— se reparte una cifra en cada uno.
 */
function applyOtpToPage(selector, otp) {
  let nodes;
  try {
    nodes = Array.from(document.querySelectorAll(selector));
  } catch {
    return { ok: false, reason: 'BAD_SELECTOR' };
  }
  if (nodes.length === 0) return { ok: false, reason: 'NOT_FOUND' };

  const protoOf = (node) =>
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : node instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;

  for (const node of nodes) {
    if (!protoOf(node)) return { ok: false, reason: 'NOT_AN_INPUT' };
    if (node.disabled || node.readOnly) return { ok: false, reason: 'NOT_EDITABLE' };
  }

  if (nodes.length > 1 && nodes.length !== otp.length) {
    return {
      ok: false,
      reason: 'FIELD_COUNT_MISMATCH',
      fields: nodes.length,
      digits: otp.length,
    };
  }
  const values = nodes.length === 1 ? [otp] : otp.split('');

  // `node.value = otp` no basta: los frameworks sustituyen el setter en la
  // instancia y pierden el valor al re-renderizar. Se usa el setter nativo del
  // prototipo y se emite un `input` que burbujee. Se enfoca cada campo antes de
  // escribir porque los grupos de casillas mueven el foco por su cuenta.
  nodes.forEach((node, index) => {
    node.focus();
    const setter = Object.getOwnPropertyDescriptor(protoOf(node), 'value').set;
    setter.call(node, values[index]);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });

  nodes[nodes.length - 1].focus();
  return { ok: true };
}

/** Busca una pestaña que coincida con el origen del portal configurado. */
async function findPortalTab(portalOrigin) {
  try {
    const tabs = await chrome.tabs.query({ url: portalOrigin });
    return tabs.find((t) => t.id != null) || null;
  } catch {
    return null;
  }
}

/** Lee la identificación del usuario y su userData desde el portal. */
async function readIdentification(portalOrigin) {
  const tab = await findPortalTab(portalOrigin);
  if (!tab) {
    throw new OtpError(
      'NO_PORTAL_TAB',
      'No hay ninguna pestaña abierta del portal configurado. Ábrela e inténtalo de nuevo.',
    );
  }

  let injectionResults;
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readUserDataFromPage,
    });
  } catch (err) {
    throw new OtpError(
      'NO_PERMISSION',
      `No se pudo leer la pestaña del portal (${err.message}). Vuelve a guardar el origen en Opciones para conceder permiso.`,
    );
  }

  const result = injectionResults && injectionResults[0] && injectionResults[0].result;
  if (!result || !result.ok) {
    if (result && result.reason === 'NO_USERDATA') {
      throw new OtpError(
        'NO_USERDATA',
        'La pestaña del portal no tiene "userData" en sessionStorage. ¿El usuario inició sesión en el portal?',
      );
    }
    throw new OtpError(
      'BAD_USERDATA',
      'No se pudo leer/parsear "userData" del portal.',
    );
  }

  const userData = result.data;
  const identification = userData && userData.identificationNumber;
  if (!identification) {
    throw new OtpError(
      'NO_IDENTIFICATION',
      'El objeto "userData" no contiene la key "identificationNumber".',
    );
  }

  return { identification: String(identification), userData };
}

/**
 * Devuelve el desfase con el reloj del servidor. Usa la lectura en memoria; si
 * no sirve, la guardada en sesión; y como último recurso, el reloj local.
 */
async function getClockOffset() {
  const live = getClockObservation();
  if (isClockSyncFresh(live)) {
    await chrome.storage.session.set({ clockSync: live });
    return { ...live, source: 'server' };
  }

  const { clockSync } = await chrome.storage.session.get('clockSync');
  if (isClockSyncFresh(clockSync)) {
    restoreClockObservation(clockSync);
    return { ...clockSync, source: 'server' };
  }

  return { offsetMs: 0, source: 'local', observedAt: Date.now() };
}

/** Calcula cuándo caducan los códigos mostrados, según el reloj del servidor. */
async function computeExpiry(config) {
  const sync = await getClockOffset();

  return {
    expiresAt: computeWindowEnd(config.otpPeriod, sync.offsetMs),
    otpPeriod: config.otpPeriod,
    clockSource: sync.source,
    clockError: sync.error || null,
    clockSyncedAt: sync.observedAt,
  };
}

/** Olvida la última consulta para que el popup no la reenseñe al reabrirse. */
async function discardCache(error) {
  await chrome.storage.session.remove('lastResult');
  return error;
}

/** Flujo completo: lee el portal, consulta la tabla y todos los OTP. */
async function runRefresh() {
  const config = await loadConfig();
  if (!isConfigComplete(config)) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'Falta configuración. Abre Opciones y define el portal y las credenciales del sitio OTP.',
    };
  }

  try {
    const { identification, userData } = await readIdentification(config.portalOrigin);

    // Sin tipo de usuario no se toca el sitio OTP.
    const userType = resolveUserType(userData);
    if (!userType.ok) return discardCache(userType);

    // La tabla se filtra antes de pedir los OTP, para no gastar una petición
    // por cada fila que vamos a descartar.
    const found = await getDevicesForIdentification(config, identification);
    const selection = selectDevicesForUser(found, userType.userType, userData.userName);
    if (!selection.ok) return discardCache(selection);

    const devices = await getOtpsForDevices(config, selection.devices);
    const payload = {
      ok: true,
      identification,
      userData,
      devices,
      fetchedAt: Date.now(),
      ...(await computeExpiry(config)),
    };
    await chrome.storage.session.set({ lastResult: payload });
    return payload;
  } catch (err) {
    return {
      ok: false,
      code: err instanceof OtpError ? err.code : 'UNKNOWN',
      message: err.message || String(err),
    };
  }
}

/**
 * Refresco ligero al caducar un código: relee solo los OTP de los dispositivos
 * ya conocidos, sin consultar de nuevo la tabla ni el portal.
 */
async function runRefreshOtps() {
  const config = await loadConfig();
  if (!isConfigComplete(config)) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Falta configuración.' };
  }

  const { lastResult } = await chrome.storage.session.get('lastResult');
  if (!lastResult || !lastResult.ok || !lastResult.devices?.length) {
    // Sin consulta previa que refrescar: toca hacer la consulta completa.
    return { ok: false, code: 'NO_CACHE', message: 'No hay una consulta previa que refrescar.' };
  }

  try {
    const devices = await getOtpsForDevices(config, lastResult.devices);

    // Diagnóstico sin exponer valores: ¿el refresco trajo códigos nuevos?
    const before = lastResult.devices.map((d) => d.otp).join('|');
    const after = devices.map((d) => d.otp).join('|');
    console.info(
      '[OTP] Refresco automático:',
      after === before ? 'código SIN CAMBIAR (se consultó demasiado pronto)' : 'código nuevo',
    );

    const payload = {
      ...lastResult,
      devices,
      fetchedAt: Date.now(),
      ...(await computeExpiry(config)),
    };
    await chrome.storage.session.set({ lastResult: payload });
    return payload;
  } catch (err) {
    return {
      ok: false,
      code: err instanceof OtpError ? err.code : 'UNKNOWN',
      message: err.message || String(err),
    };
  }
}

/** Escribe el OTP en el campo del portal indicado por el selector configurado. */
async function runApplyOtp(otp) {
  if (!otp) return { ok: false, code: 'NO_OTP', message: 'No hay código que aplicar.' };

  const config = await loadConfig();
  if (!config.otpInputSelector) {
    return {
      ok: false,
      code: 'NO_SELECTOR',
      message: 'No hay ningún campo configurado en Opciones.',
    };
  }

  const tab = await findPortalTab(config.portalOrigin);
  if (!tab) {
    return {
      ok: false,
      code: 'NO_PORTAL_TAB',
      message: 'No hay ninguna pestaña abierta del portal configurado.',
    };
  }

  let injectionResults;
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: applyOtpToPage,
      args: [config.otpInputSelector, String(otp)],
    });
  } catch (err) {
    return { ok: false, code: 'NO_PERMISSION', message: `No se pudo escribir en el portal: ${err.message}` };
  }

  const result = injectionResults && injectionResults[0] && injectionResults[0].result;
  if (result && result.ok) return { ok: true };

  const REASONS = {
    BAD_SELECTOR: 'El selector configurado no es válido.',
    NOT_FOUND: 'No se encontró el campo en la página del portal.',
    NOT_AN_INPUT: 'El selector no apunta a un input ni a un textarea.',
    NOT_EDITABLE: 'El campo está deshabilitado o es de solo lectura.',
  };
  const reason = (result && result.reason) || 'NOT_FOUND';
  if (reason === 'FIELD_COUNT_MISMATCH') {
    return {
      ok: false,
      code: reason,
      message: `El selector encuentra ${result.fields} campos y el código tiene ${result.digits} cifras.`,
    };
  }
  return { ok: false, code: reason, message: REASONS[reason] || 'No se pudo escribir el código.' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'REFRESH') {
    runRefresh().then(sendResponse);
    return true; // mantiene abierto el canal para la respuesta asíncrona
  }
  if (message?.type === 'REFRESH_OTPS') {
    runRefreshOtps().then(sendResponse);
    return true;
  }
  if (message?.type === 'APPLY_OTP') {
    runApplyOtp(message.otp).then(sendResponse);
    return true;
  }
  return false;
});
