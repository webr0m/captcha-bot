# Telegram, Mini App y publicidad

## Controles del chat

Los ajustes disponibles en la Mini App también se pueden administrar desde el privado del bot con `/config`. Se conservan los menús existentes de captcha, mensajes, idiomas, filtros, tópicos y estadísticas, y se añaden:

- Captcha → Escribir tiempo exacto, entre 5 y 3600 segundos.
- Moderación → Límites y duración anti-flood: valores rápidos, límite exacto de 3 a 50 mensajes cada 10 segundos y silencio de 1 a 1440 minutos, incluidas fracciones.
- Moderación → Gestionar enlaces permitidos: consultar con páginas de diez extras, añadir, quitar, reemplazar o vaciar la lista extra con confirmación. Los enlaces oficiales se conservan.
- Modo nocturno → Desactivar: utiliza la misma escritura y restauración por cola que la Mini App, conservando los permisos originales.

Los nuevos controles usan `saveSettings`, la misma validación y transacción de la Mini App. Cada cambio comprueba la administración actual en Telegram. Las respuestas privadas caducan en quince minutos y aceptan `/cancel`. Los comandos y los códigos de verificación de canales mantienen su prioridad. Una pregunta nueva sustituye la anterior; los botones antiguos no cancelan preguntas nuevas y la limpieza compara el valor antes de eliminarlo.

La apariencia visual Día/Noche y el widget de traducción pertenecen al panel web. El tema de la aplicación Telegram lo controla cada usuario desde su cliente.

## Botón Menú

El Worker configura el botón predeterminado de Telegram como `📱 Panel`, con enlace a `https://verify.webrom.cc/miniapp`, mediante `setChatMenuButton`. Después comprueba el resultado con `getChatMenuButton` y registra la configuración en Redis. No necesita exportar BOT_TOKEN ni enviar mensajes para aplicarlo.

La migración se intenta desde el cron si queda presupuesto de peticiones. Si Telegram no confirma el cambio, se reintenta en un ciclo posterior. Una vez confirmado, se consulta solo la marca de Redis. `/miniapp`, sus alias y los botones web de `/config` siguen disponibles.

## Banner

Se incorpora el código recibido de data527.click, con el mismo placement y consulta de afiliación, usando HTTPS. Se muestra tras cargar la configuración de un grupo, entre la cabecera y el contenido, con ancho máximo de 728 px y 90 px de alto para la creatividad. Se pasa al proveedor el ancho disponible en móvil.

El proveedor ejecuta scripts, sustituye `document.write` y gestiona mensajes del navegador. Por ello se aloja en `/miniapp/ad`, dentro de un iframe con sandbox sin `allow-same-origin` ni navegación superior. No recibe initData, ajustes, nombres de grupos ni parámetros de la página principal. El marco usa no-referrer, y el widget de idiomas no traduce publicidad. La altura exterior permanece limitada para no cubrir los controles.

El proveedor y el aislamiento tienen un controlador de carga independiente. Un mensaje del marco solo puede cambiar la visibilidad de su propio espacio, comprobando `event.source`. Si el script falla o no crea contenido en veinte segundos, se oculta el espacio vacío. No hay temporizador de refresco publicitario: cambiar de sección, guardar o cambiar de grupo conserva la misma carga.

La entrega efectiva de creatividades depende del proveedor y de las restricciones del navegador. En la prueba local el proveedor no entregó un anuncio visible; se comprobó que el espacio se oculta y la Mini App continúa funcionando. No se realizan clics sobre anuncios de prueba.

## Validación

124 pruebas locales pasan: se añaden trece casos para sincronización chat/Mini App, entradas exactas, validación, permisos revocados, prioridad de verificaciones, preguntas y cancelaciones antiguas, operaciones de enlaces, restauración nocturna, configuración y reintento del botón Menú y aislamiento del banner. Typecheck y empaquetado de Wrangler pasan.

Referencia oficial: [setChatMenuButton](https://core.telegram.org/bots/api#setchatmenubutton).
