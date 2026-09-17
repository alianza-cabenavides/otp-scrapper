// Configuración persistida en chrome.storage.local, compartida por el popup,
// la página de opciones y el service worker.
// Ningún host viene fijado en el código: la Base URL la introduce el usuario.

/** Duración de la ventana OTP en segundos. */
const DEFAULT_OTP_PERIOD = 60;

const KEYS = ['portalOrigins', 'portalOrigin', 'username', 'password', 'baseUrl', 'otpPeriod',
  'otpInputSelector'];

function normalizePortalOrigins(config) {
  const origins = Array.isArray(config.portalOrigins)
    ? config.portalOrigins
    : [config.portalOrigin];

  return [...new Set(origins
    .filter((origin) => typeof origin === 'string')
    .map((origin) => origin.trim())
    .filter(Boolean))];
}

/** Lee la configuración guardada. */
export async function loadConfig() {
  const stored = await chrome.storage.local.get(KEYS);
  const portalOrigins = normalizePortalOrigins(stored);
  return {
    portalOrigins,
    // Se conserva durante la migración para consumidores/configuraciones antiguas.
    portalOrigin: portalOrigins[0] || '',
    username: stored.username || '',
    password: stored.password || '',
    baseUrl: (stored.baseUrl || '').replace(/\/+$/, ''),
    otpPeriod: Number(stored.otpPeriod) > 0 ? Number(stored.otpPeriod) : DEFAULT_OTP_PERIOD,
    // Selector CSS del campo del portal donde escribir el código. Vacío
    // significa que el botón de aplicar no se ofrece.
    otpInputSelector: (stored.otpInputSelector || '').trim(),
  };
}

/** Guarda la configuración. */
export async function saveConfig(config) {
  const portalOrigins = normalizePortalOrigins(config);
  await chrome.storage.local.set({
    portalOrigins,
    portalOrigin: portalOrigins[0] || '',
    username: config.username || '',
    password: config.password || '',
    baseUrl: (config.baseUrl || '').replace(/\/+$/, ''),
    otpPeriod: Number(config.otpPeriod) > 0 ? Number(config.otpPeriod) : DEFAULT_OTP_PERIOD,
    otpInputSelector: (config.otpInputSelector || '').trim(),
  });
}

/** Indica si está la configuración mínima para poder consultar. */
export function isConfigComplete(config) {
  return Boolean(
    normalizePortalOrigins(config).length
      && config.username && config.password && config.baseUrl,
  );
}
