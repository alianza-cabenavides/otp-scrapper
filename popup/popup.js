import { USER_TYPE_LEGAL } from '../lib/device-selection.js';
import { loadConfig } from '../lib/config.js';

const contentEl = document.getElementById('content');
const footerEl = document.getElementById('footer');
const refreshBtn = document.getElementById('refresh');
const optionsBtn = document.getElementById('open-options');
const countdownEl = document.getElementById('countdown');
const countdownText = document.getElementById('countdown-text');
const ringFg = document.getElementById('ring-fg');

const RING_CIRCUMFERENCE = 100.53; // 2*pi*r con r=16

/** Cuánto dura el mensajito que confirma la escritura o explica el fallo. */
const FLASH_MS = 2000;

/** Si hay un campo configurado en Opciones, se ofrece el botón de aplicar. */
let canApplyOtp = false;

/** Margen tras el fin de la ventana antes de releer, para no caer en la vieja. */
const REFRESH_GRACE_MS = 2000;

/** Esperas antes de reintentar tras un fallo de red, con retroceso progresivo. */
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];

/** Estado de la cuenta atrás del código mostrado. */
const timer = {
  expiresAt: 0,
  period: 60,
  handle: null,
  refreshing: false,
  failures: 0,   // fallos consecutivos, para el retroceso
  retryAt: 0,    // instante del próximo reintento (0 = cadencia normal)
};

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
};

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Flecha hacia abajo sobre una línea: escribir el código en el campo. */
const ICON_APPLY = 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z';

/** Botón de icono, con el mismo componente .btn--icon que usa la barra. */
function iconButton(path, label, onClick) {
  const button = el('button', { className: 'btn btn--icon', type: 'button', title: label });
  button.setAttribute('aria-label', label);
  button.innerHTML =
    `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">`
    + `<path d="${path}"/></svg>`;
  button.addEventListener('click', onClick);
  return button;
}

/** Mensaje efímero bajo el código: confirma la escritura o explica el fallo. */
function flash(node, message, isError) {
  node.textContent = message;
  node.classList.toggle('flash-error', Boolean(isError));
  clearTimeout(flash.timers.get(node));
  flash.timers.set(node, setTimeout(() => {
    node.textContent = '';
    node.classList.remove('flash-error');
  }, FLASH_MS));
}
flash.timers = new WeakMap();

function showSpinner() {
  clear(contentEl);
  contentEl.append(el('div', { className: 'spinner' }));
  footerEl.textContent = '';
}

/** Errores de los datos del portal: Opciones no los arregla. */
const USER_DATA_ERRORS = new Set(['NO_USER_TYPE', 'NO_USER_NAME', 'NO_ACCOUNT_MATCH']);

function showError(message, code) {
  clear(contentEl);
  const box = el('div', { className: 'error' });
  box.append(el('span', { textContent: message }));
  if (!USER_DATA_ERRORS.has(code)) {
    box.append(el('span', { textContent: ' ' }));
    const link = el('span', { className: 'link', textContent: 'Abrir Opciones' });
    link.addEventListener('click', () => chrome.runtime.openOptionsPage());
    box.append(link);
  }
  contentEl.append(box);
  footerEl.textContent = '';
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

/** Mismo criterio de normalización que el filtro de device-selection.js. */
function isLegalUser(userData) {
  const raw = userData && userData.userType;
  return typeof raw === 'string' && raw.trim().toLowerCase() === USER_TYPE_LEGAL;
}

function renderOtpCard(device, result) {
  const card = el('div', { className: 'otp-card' });

  if (device.otp) {
    const otp = el('div', { className: 'otp', textContent: device.otp });
    const row = el('div', { className: 'otp-row' }, [otp]);
    card.append(row);

    // Sin campo configurado no hay acción posible.
    if (canApplyOtp) {
      const notice = el('div', { className: 'otp-flash' });
      const apply = async () => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'APPLY_OTP', otp: device.otp });
          if (response?.ok) {
            window.close();
            return;
          }
          flash(notice, response?.message || 'No se pudo escribir el código.', true);
        } catch (err) {
          flash(notice, err.message, true);
        }
      };
      row.append(iconButton(ICON_APPLY, 'Escribir el código en el portal', apply));
      card.append(notice);
    }
  } else {
    card.append(el('div', { className: 'otp-none', textContent: device.error ? 'Error al obtener OTP' : 'Sin OTP' }));
  }

  const dl = el('dl');
  const row = (label, value) => {
    if (!value) return;
    dl.append(el('dt', { textContent: label }));
    dl.append(el('dd', { textContent: String(value) }));
  };
  row('Aplicación', device.application);
  // La identificación viene del portal: en un usuario legal `device.account`
  // trae el nombre de la cuenta, no la identificación.
  row('Identificación', result.identification);
  // Sólo un usuario legal tiene varias cuentas bajo una misma identificación.
  if (isLegalUser(result.userData)) row('Usuario', result.userData.userName);
  card.append(dl);
  return card;
}

function renderResult(result) {
  clear(contentEl);

  if (!result.devices || result.devices.length === 0) {
    // Sin tarjetas, la identificación va en el propio mensaje.
    contentEl.append(el('p', {
      className: 'empty',
      textContent: `No se encontraron dispositivos para ${result.identification}.`,
    }));
  } else {
    for (const device of result.devices) {
      contentEl.append(renderOtpCard(device, result));
    }
  }

  const clockNote =
    result.clockSource === 'server'
      ? 'sincronizado con el servidor'
      : 'reloj local (sin sincronizar)';
  footerEl.textContent = `Actualizado ${fmtTime(result.fetchedAt)} · ${clockNote}`;
}

// ----------------------------------------------------------- cuenta atrás
function stopCountdown() {
  if (timer.handle) clearInterval(timer.handle);
  timer.handle = null;
  countdownEl.hidden = true;
}

/** Programa el siguiente reintento tras un fallo, con retroceso progresivo. */
function scheduleRetry() {
  const delay = RETRY_DELAYS_MS[Math.min(timer.failures, RETRY_DELAYS_MS.length - 1)];
  timer.failures++;
  timer.retryAt = Date.now() + delay;
  footerEl.textContent =
    `Sin conexión con el sitio OTP · reintentando en ${Math.round(delay / 1000)} s`;
}

/** Refresco ligero: sólo relee los OTP, sin volver a pedir la tabla. */
async function autoRefresh() {
  if (timer.refreshing) return;
  timer.refreshing = true;
  timer.retryAt = 0;
  countdownText.textContent = '…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'REFRESH_OTPS' });

    if (response?.code === 'NO_CACHE') {
      stopCountdown(); // nada que refrescar; el botón hará la consulta completa
      return;
    }

    // Si ningún dispositivo trajo código, la consulta falló aunque venga ok.
    const failed = !response?.ok || !response.devices?.some((d) => d.otp);
    if (failed) {
      if (response?.ok) renderResult(response);
      else showError(response?.message || 'No se pudo refrescar el código.');
      scheduleRetry();
      return;
    }

    timer.failures = 0;
    render(response);
  } catch (err) {
    showError(`No se pudo contactar el proceso en segundo plano: ${err.message}`);
    scheduleRetry();
  } finally {
    timer.refreshing = false;
  }
}

function tick() {
  // Un reintento pendiente manda sobre la cadencia normal.
  if (timer.retryAt) {
    if (Date.now() >= timer.retryAt) autoRefresh();
    return;
  }

  const remainingMs = timer.expiresAt - Date.now();
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));

  countdownText.textContent = remaining > 0 ? remaining : '0';
  const ratio = Math.max(0, Math.min(1, remainingMs / (timer.period * 1000)));
  ringFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));

  countdownEl.classList.toggle('urgent', remaining <= 10 && remaining > 0);
  countdownEl.classList.toggle('expired', remaining <= 0);

  // El anillo llega a cero en el borde real; la consulta espera el margen.
  if (remainingMs <= -REFRESH_GRACE_MS) autoRefresh();
}

function startCountdown(expiresAt, period) {
  timer.expiresAt = expiresAt;
  timer.period = period || 60;
  timer.retryAt = 0; // se vuelve a la cadencia normal
  countdownEl.hidden = false;
  if (timer.handle) clearInterval(timer.handle);
  timer.handle = setInterval(tick, 250);
  tick();
}

function render(response) {
  if (response && response.ok) {
    renderResult(response);
    // Basta con que haya dispositivos: si no trajeron código, el contador
    // debe seguir vivo para volver a intentarlo.
    if (response.expiresAt && response.devices?.length) {
      startCountdown(response.expiresAt, response.otpPeriod);
    } else {
      stopCountdown();
    }
  } else {
    stopCountdown();
    showError((response && response.message) || 'Ocurrió un error inesperado.', response && response.code);
  }
}

async function refresh() {
  refreshBtn.disabled = true;
  showSpinner();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'REFRESH' });
    render(response);
  } catch (err) {
    showError(`No se pudo contactar el proceso en segundo plano: ${err.message}`);
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', refresh);
optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

// Al abrir, muestra el último resultado guardado para no arrancar en vacío.
(async () => {
  // El botón de aplicar depende de la configuración, así que se lee primero.
  try {
    canApplyOtp = Boolean((await loadConfig()).otpInputSelector);
  } catch { /* sin configuración accesible */ }

  try {
    const { lastResult } = await chrome.storage.session.get('lastResult');
    if (lastResult) render(lastResult);
  } catch { /* sin resultado previo */ }
})();
