// Decide qué dispositivos se consultan según el tipo de usuario del portal.

/** Valores de `userData.userType` que el portal puede indicar. */
export const USER_TYPE_NATURAL = 'natural';
export const USER_TYPE_LEGAL = 'legal';

/**
 * Normaliza `userData.userType`. Sin un tipo conocido no se consulta nada: no
 * sabríamos si hay que filtrar, y la tabla entera puede traer OTP ajenos.
 * @returns {{ok:true, userType:string}|{ok:false, code:string, message:string}}
 */
export function resolveUserType(userData) {
  const raw = userData && userData.userType;
  const userType = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  if (userType === USER_TYPE_NATURAL || userType === USER_TYPE_LEGAL) {
    return { ok: true, userType };
  }

  return {
    ok: false,
    code: 'NO_USER_TYPE',
    message:
      'El portal no indica el tipo de usuario ("userType"), así que no se consultan los OTP. ' +
      'Vuelve a iniciar sesión en el portal e inténtalo de nuevo.',
  };
}

/**
 * Deja los dispositivos del usuario en sesión. Un usuario "legal" puede tener
 * varias cuentas bajo la misma identificación: se elige la que coincide con
 * `userName` y, si coincide más de una, la primera de la respuesta.
 * @returns {{ok:true, devices:Array}|{ok:false, code:string, message:string}}
 */
export function selectDevicesForUser(devices, userType, userName) {
  if (userType !== USER_TYPE_LEGAL) return { ok: true, devices };

  const account = typeof userName === 'string' ? userName.trim() : '';
  if (!account) {
    return {
      ok: false,
      code: 'NO_USER_NAME',
      message:
        'El usuario es de tipo "legal" pero el portal no indica su "userName", ' +
        'necesario para saber cuál de sus cuentas consultar.',
    };
  }

  // Sin filas no hay nada que filtrar; el popup ya avisa de la tabla vacía.
  if (devices.length === 0) return { ok: true, devices };

  // El portal garantiza que no hay cuentas que difieran solo por mayúsculas.
  const normalizedAccount = account.toLowerCase();
  const matches = devices.filter(
    (device) =>
      typeof device.account === 'string' && device.account.toLowerCase() === normalizedAccount,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'NO_ACCOUNT_MATCH',
      message:
        `Ninguna de las ${devices.length} cuentas asociadas a esta identificación corresponde ` +
        `al usuario en sesión ("${account}"), así que no hay OTP que mostrar.`,
    };
  }

  return { ok: true, devices: [matches[0]] };
}
