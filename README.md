# Alianza OTP Pruebas

Extensión de Chrome que muestra los OTP disponibles de un usuario.

La identificación del usuario se toma del `sessionStorage["userData"]` de la pestaña del portal,
y los OTP se leen del sitio de administración de tokens iniciando sesión con tus credenciales.

## Instalación

1. Abre `chrome://extensions`.
2. Activa **Modo de desarrollador**.
3. **Cargar descomprimida** → selecciona esta carpeta.

## Configuración

Abre las **Opciones** de la extensión (icono ⚙️ en el popup) y rellena:

- **URLs de los portales** — los sitios donde vive `sessionStorage["userData"]`, con una URL
  por línea.
- **Base URL del sitio OTP** — la URL del administrador de tokens.
- **Usuario** y **Contraseña** del sitio OTP.
- **Selector CSS del campo** (opcional) — el campo del portal donde escribir el código. Se
  busca con `document.querySelectorAll` y debe apuntar a `input` o `textarea` editables. Un
  único campo recibe el código completo; si el portal usa un grupo de casillas de un dígito,
  haz que el selector las abarque todas (p. ej. `input.token-digit`) y se reparte una cifra
  en cada una. Vacío, el botón de escribir no aparece.

Pulsa **Guardar** y acepta el permiso que solicita Chrome para acceder a los portales y al sitio OTP.

> La contraseña se guarda en `chrome.storage.local` en texto plano, local a la extensión.

## Uso

1. Abre una pestaña de cualquiera de los portales configurados con el usuario ya autenticado.
2. Abre el popup de la extensión; la consulta se inicia automáticamente.
3. Se muestra una tarjeta por cada dispositivo con su OTP, la identificación y —en un
   usuario legal— la cuenta en sesión.

En aperturas posteriores se valida el usuario activo y se reutiliza el resultado de la sesión
mientras el OTP siga vigente. Si venció, solo se vuelven a consultar los OTP de los dispositivos
ya conocidos. El botón **Refrescar** fuerza una consulta completa.

Junto al código hay un botón que lo escribe en el campo del portal, y solo aparece si
configuraste el selector.

Si hay varios portales abiertos, se usa primero el portal activo en la última ventana enfocada;
en su defecto, la pestaña de portal utilizada más recientemente.

Un contador circular indica la vida restante del código. Al llegar a cero, la extensión
vuelve a leer los OTP automáticamente mientras el popup siga abierto.

### Tipo de usuario

El campo `userType` de `userData` decide qué se muestra:

| `userType` | Comportamiento |
|------------|----------------|
| `natural` | Todos los dispositivos de la identificación. |
| `legal` | Solo el dispositivo cuya **`Cuenta` coincida con `userName`** (distingue mayúsculas; si coinciden varias, la primera). Sin coincidencia, se avisa. |
| vacío u otro valor | No se consulta y se avisa. |

## Estructura

| Ruta | Rol |
|------|-----|
| `manifest.json` | Manifiesto MV3 |
| `background/service-worker.js` | Lee el portal y consulta el sitio OTP |
| `lib/alianza-client.js` | Login y consultas HTTP |
| `lib/device-selection.js` | Filtro por `userType` / `userName` |
| `lib/parsers.js` | Extrae los datos del HTML del sitio |
| `lib/config.js` | Configuración en `chrome.storage.local` |
| `popup/` | Interfaz: tarjetas de OTP y botón Refrescar |
| `options/` | Formulario de configuración |
| `styles/app.css` | Hoja compartida por popup y opciones (importa el resto) |
| `styles/tokens.css` | Paleta, tipografía, espaciados y radios |
| `styles/reset.css` | Reset mínimo y base de `<body>` |
| `styles/typography.css` | Títulos, `.hint`, `code` |
| `styles/components/` | `.btn`, `.card`, `.field`/`.input` |
