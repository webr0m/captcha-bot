# Arranque, permisos y listado de grupos · 29 de octubre de 2026

## Configuración inicial

- Captcha **ON** y modo **Turnstile** cuando no hay una elección guardada. El runtime, /config, el resumen y las estadísticas comparten los mismos valores iniciales.
- SET NX rellena las claves ausentes en grupos nuevos y existentes. No sobrescribe un OFF explícito ni otro modo elegido por un administrador.
- La primera pulsación sobre el ON implícito lo desactiva correctamente.

## Salida automática

La función ya existía al recibir `my_chat_member`. Ahora el cron revisa también los grupos registrados, dos por lote, con un inventario estable y cursor persistente. Posponer el mantenimiento cuando ya se usaron más de 20 llamadas Redis/Telegram deja margen al plan gratuito.

Se requieren permisos de **borrar mensajes** y **restringir miembros**, además de administración. Si faltan, se programa una salida cinco minutos después y se avisa cuando Telegram permite enviar el mensaje. Mientras está pendiente, el dispatcher no procesa moderación ni emite nuevos desafíos en ese grupo.

La tarea vuelve a consultar los permisos antes de salir. La recuperación cancela la salida; una tarea anterior no puede acortar un plazo nuevo. Un error temporal de getMe, getChatMember, getChat o leaveChat no se interpreta como falta de permisos ni se pierde silenciosamente: el cron reintenta los fallos transitorios. En canales se conserva el requisito anterior de ser administrador.

## Cinco grupos administrados por página

El tamaño ya era cinco, pero el total se calculaba sobre todos los grupos conocidos. Se añade un índice de descubrimiento por administrador, mantenido al consultar las listas de administradores y comprobar accesos. La lista usa este índice tras la primera revisión completa; excluye grupos que el bot ya abandonó.

El índice no autoriza acciones. Cada fila comprueba al administrador en vivo y los cambios siguen comprobando permisos con Telegram. Los IDs, callbacks y nombres de grupos se conservan. Los mensajes antiguos del menú se actualizan al pulsar sus botones o al volver a ejecutar /config.

## Validación

- **94 pruebas aprobadas**, TypeScript y empaquetado de Wrangler correctos.
- Regresiones nuevas: ON/Turnstile, conservación de OFF y modos explícitos, primera pulsación, Turnstile dentro de 50 llamadas, salida diferida, cancelación, tareas antiguas, reintentos, revisión con cursor y presupuesto, y 12 grupos administrados entre 80 conocidos paginados 5/5/2.
- Se completó la revisión inicial de un inventario de **41 grupos** mediante lotes en Cloudflare y el cron. Los 19 lotes manuales observaron 37 grupos: 26 listos, 11 con salida programada y cero errores de consulta. Los otros lotes los atendió el cron; los contadores manuales no son un total exhaustivo ni prueban que ya se haya ejecutado una salida.
- La herramienta temporal de actualización usó una clave aleatoria y caducidad, no devolvió IDs, nombres ni credenciales. El archivo y la ruta se retiran al finalizar.
- No se probaron sanciones o salidas artificiales sobre grupos reales. Las salidas programadas corresponden a permisos consultados realmente; se ejecutarán solo si siguen faltando al finalizar el plazo.

Referencias: [permisos del administrador](https://core.telegram.org/bots/api#chatmemberadministrator), [leaveChat](https://core.telegram.org/bots/api#leavechat), [límites de Workers](https://developers.cloudflare.com/workers/platform/limits/).
