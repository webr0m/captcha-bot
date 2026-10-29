# Revisión de AntiUBot · 29 de octubre de 2026

## Cambios implementados

- `/config` muestra los nombres de los grupos en la lista inicial, al actualizar y al volver a Mis grupos. Conserva el ID en los callbacks; si Telegram no permite consultar el título, usa `Grupo <ID>`.
- Menú principal compacto: Captcha, Moderación, Mensajes y avisos, Idioma y filtros, Tópicos (solo foros), Modo nocturno, Estadísticas, Resumen y Ayuda. Los cambios mantienen abierto su submenú.
- Ayuda con instrucciones de configuración, límites, comandos, tópicos y solución de problemas.
- Respuestas, imágenes, stickers y avisos se envían al tópico del update. El contexto se crea por petición y no se propaga a privados ni a otros grupos. Ediciones y borrados siguen usando el ID del mensaje.
- Destino configurable de captcha por grupo desde el menú o con `/topico captcha aqui|general|off`. Los tópicos se descubren mediante mensajes y eventos de creación, cambio de nombre, cierre y reapertura. Hay paginación y se rechazan destinos cerrados conocidos.

## Bugs corregidos

1. Se ignoraba `new_chat_members`, el campo actual de Telegram: ahora se verifica a cada miembro de la lista, también en grupos básicos.
2. Las autorizaciones permanentes permitían conservar acceso tras perder la administración. Los cambios consultan Telegram; la caché de moderación dura 60 s y no acepta las claves permanentes antiguas.
3. Cualquier administrador de un grupo podía iniciar un broadcast a usuarios de todos los grupos. Se limita al propietario existente del bot y al chat privado.
4. Comandos y mensajes editados podían esquivar el filtro de enlaces. Los mensajes pendientes de captcha también se procesan antes de los comandos.
5. La resta mostrada podía tener una respuesta distinta a la guardada: ahora conserva el resultado con signo.
6. Un mute inferior a 30 s se podía interpretar como permanente en Telegram: se usa un mínimo de 60 s.
7. Expulsiones antiguas podían actuar sobre verificaciones canceladas o perderse ante errores. Se exige estado pendiente, se reclama la tarea con SREM, se preservan fallos transitorios y se hace atómica la transición entre verificación y expiración.
8. Los callbacks de desafíos antiguos podían afectar desafíos nuevos. Se comprueban mensaje, estado y deadline. La verificación simultánea se cuenta una sola vez.
9. Las solicitudes de canal enviaban el mensaje al identificador incorrecto; usan `user_chat_id`. Corregir el código cancela el ban y rechazo diferidos. La aprobación debe confirmarse antes de anunciar éxito.
10. Desbloquear el grupo otorgaba permisos genéricos: ahora restaura la instantánea anterior. Un bloqueo anterior a esta versión sin instantánea requiere restauración manual, para evitar ampliar permisos sin conocerlos.
11. El webhook aceptaba actualizaciones si faltaba el secreto: responde 503 si no está configurado y 401 si la cabecera no coincide. Se rechazan JSON e identificadores de update inválidos.
12. Los reintentos podían acortar `retry_after`: ya no reintentan antes del plazo solicitado.
13. El resumen mostraba `[object Promise]` en el estado del captcha.

## Compatibilidad y límites

- Se mantienen las claves de configuración, los modos, acciones y callbacks anteriores. Los grupos siguen teniendo una sola configuración y una verificación por usuario; los tópicos son destinos de mensajes, no grupos independientes.
- Las sanciones de Telegram afectan al supergrupo completo. El anti-flood agrega mensajes de todos los tópicos para evitar evasión.
- Sin destino configurado se usa el hilo del mensaje de entrada, o General cuando no hay hilo. Si un tópico configurado ya no existe o no admite mensajes, el fallo de envío cancela el desafío y no programa una expulsión nueva.
- Los estados pendientes y verificados se conservan hasta siete días para que el cron no sancione a partir de un estado desaparecido. La aceptación del desafío sigue limitada por su deadline; los tokens y respuestas mantienen su expiración propia.
- Telegram no ofrece una lista completa de tópicos al bot. Para registrar uno anterior a la instalación, enviar `/topico` dentro de él y actualizar el menú. La lista de grupos conserva el límite previo de ocho botones.
- Se mantienen los identificadores del propietario existentes en el proyecto; no se reasignan cuentas ni grupos.

## Secretos y despliegue

- Se retiró un valor con formato de secreto de Turnstile del archivo de ejemplo.
- La clave de geocodificación dejó de estar en el código y pasa a `GEOCODE_API_KEY`. Se migró la clave que ya usaba el bot al secreto de Cloudflare para conservar el modo nocturno.
- Los valores anteriores siguen en el historial Git: se recomienda rotarlos con los proveedores correspondientes. No se ha cambiado la clave de Turnstile de producción sin conocer la configuración del widget.
- `WEBHOOK_SECRET` es obligatorio. La instalación actual ya lo tiene.
- El webhook debe incluir `edited_message` en `allowed_updates`, además de `message`, `callback_query`, `chat_join_request` y `my_chat_member`.

## Validación

- 57 pruebas automatizadas: reglas puras y flujos con Redis/Telegram simulados, usando el código real del Worker.
- Regresión de emisión, respuesta y limpieza de button/math/qr/emoji/image/dice dentro de tópicos; Turnstile silencioso y fallback al grupo.
- Navegación de `/config`, ayuda, nombres y respaldo, permisos, selección de tópicos, paginación, cierres y actualizaciones concurrentes.
- TypeScript y empaquetado de Wrangler comprobados. Estas pruebas no sustituyen una validación manual con clientes reales de Telegram ni validan visualmente las imágenes generadas por servicios externos.

## Mejoras siguientes

- Cola duradera con confirmación y recuperación tras interrupción abrupta. El SREM evita ejecutar la misma entrada dos veces entre cron concurrentes, pero un proceso interrumpido después de reclamarla todavía puede perderla.
- Deduplificación de webhooks por `update_id` y recuperación de errores: la implementación conserva el procesamiento en `waitUntil`; un error posterior al 200 no provoca reenvío de Telegram.
- Separar el broadcast en lotes persistentes para grupos grandes; el envío actual puede exceder el tiempo de ejecución.
- Sustituir `KEYS` por índices/SCAN y reducir escrituras de metadatos por mensaje para mejorar el coste de Redis.
- Captchas por imagen y QR generados localmente, y enlaces Turnstile ligados a una sesión impredecible.
- Zona horaria IANA para el modo nocturno manual: el offset fijo anterior no se ajusta automáticamente al horario de verano.
