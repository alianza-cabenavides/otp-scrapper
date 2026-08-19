// Parseo del HTML del sitio OTP, sin dependencias.
// Con expresiones regulares para poder ejecutarlo en el service worker MV3,
// que no dispone de DOMParser.

/** Decodifica las entidades HTML que aparecen en la salida del servidor. */
function decodeEntities(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#xF1;/gi, 'ñ')
    .replace(/&#xF3;/gi, 'ó')
    .replace(/&nbsp;/g, ' ');
}

/** Quita etiquetas y deja el texto en una sola línea sin espacios sobrantes. */
function textOf(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrae el token antiforgery del HTML de la página de login.
 * @returns {string|null}
 */
export function parseAntiforgeryToken(html) {
  const match = String(html).match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
  );
  return match ? match[1] : null;
}

/** Indica si el HTML corresponde a la página de login. */
export function isLoginPage(html) {
  const h = String(html);
  return /name="UserName"/i.test(h) && /name="Password"/i.test(h);
}

/**
 * Convierte la tabla de /DeviceTokens en una lista de dispositivos.
 * @returns {Array<{deviceId,targetUser,state,account,application,testId}>}
 */
export function parseDeviceTable(html) {
  const source = String(html);
  const devices = [];

  // Solo las filas con enlace a Test son filas de datos; el resto son la
  // cabecera o la paginación.
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(source)) !== null) {
    const rowHtml = rowMatch[1];
    const testMatch = rowHtml.match(/\/DeviceTokens\/Test\/(\d+)/i);
    if (!testMatch) continue;

    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length === 0) continue;

    const stateCell = cells[2] || '';
    const state = /checked/i.test(stateCell) ? 'Activo' : 'Inactivo';

    devices.push({
      deviceId: textOf(cells[0] || ''),
      targetUser: textOf(cells[1] || ''),
      state,
      account: textOf(cells[3] || ''),
      application: textOf(cells[4] || ''),
      testId: testMatch[1],
    });
  }

  return devices;
}

/**
 * Extrae el valor "Resultado" de una página /DeviceTokens/Test/{id}.
 * Su formato es "<serial> - <otp>"; el OTP es el segundo valor.
 * @returns {{serial:string|null, otp:string|null, raw:string}|null}
 */
export function parseOtpResult(html) {
  const source = String(html);

  // Toma el <dd> que sigue al <dt> de "Resultado".
  const match = source.match(
    /Resultado\s*<\/dt>[\s\S]*?<dd>\s*([\s\S]*?)\s*<\/dd>/i,
  );
  if (!match) return null;

  const raw = textOf(match[1]);
  if (!raw) return { serial: null, otp: null, raw };

  const parts = raw.split(/\s*-\s*/);
  if (parts.length >= 2) {
    return { serial: parts[0].trim(), otp: parts.slice(1).join('-').trim(), raw };
  }
  // Sin separador: todo el valor se toma como OTP.
  return { serial: null, otp: raw, raw };
}
