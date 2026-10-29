# Rendimiento y modo nocturno · 29 de octubre de 2026

## Resultado

Se conservan las claves de Redis, las comprobaciones en vivo de administradores, las sanciones, los estados de captcha y el destino de los tópicos. No se contrata ningún servicio ni se migra la Bot API.

- El registro de usuarios usa MSET y pipeline: los nombres y los dos conjuntos de usuarios se guardan mediante una petición HTTP en lugar de cinco. El pipeline no es una transacción y no se reintenta automáticamente si hay un error parcial.
- Los 12 ajustes del menú se leen mediante un MGET, en paralelo con el nombre del grupo. Los comandos privados no consultan códigos de verificación que nunca van a utilizar.
- Las lecturas de estadísticas, metadatos y caché de acceso se agrupan. Las escrituras de caché y del registro de administradores también usan pipeline, manteniendo sus TTL. El marcador de refresco se escribe solo cuando la actualización completa tiene éxito.
- getMe se comparte por cliente/update y sus clones de tópico; no se comparte entre tokens ni se cachean sus errores. No se cachean autorizaciones en vivo ni estados de captcha.
- Los callbacks de configuración y modo nocturno no hacen una lectura redundante del idioma.
- La lista de grupos muestra **cinco candidatos por página**, según la preferencia del usuario. Solo se muestran los que autoriza Telegram; se conservan las flechas y los nombres. Los candidatos siguen siendo los grupos conocidos por el bot, por lo que una página puede contener menos de cinco grupos accesibles.

## Comparación reproducible

Ejecutar `node scripts/benchmark-flows.mjs`. Usa el código real con servicios simulados: cuenta viajes HTTP y comandos, **no mide latencia de red**.

| Flujo | HTTP antes | HTTP final |
|---|---:|---:|
| /config privado con 80 grupos conocidos | 27 | 15 |
| Abrir una sección de configuración | 19 | 6 |
| Mensaje normal en grupo | 23 | 15 |
| Mensaje con enlace bloqueado | 34 | 25 |

En /config, parte de la reducción corresponde a pasar de ocho a cinco candidatos por página; no debe atribuirse toda a optimización del transporte. Antes de cambiar la paginación, el mismo flujo de ocho candidatos bajó de 27 a 21 peticiones.

## Medición real desde Cloudflare

Se usó un diagnóstico temporal con una clave aleatoria, fecha de caducidad, respuestas sin caché y operaciones exclusivamente de lectura. Se retiraron el archivo local y la ruta; la ruta volvió a responder 404. Nunca se devolvieron credenciales, datos de usuarios ni valores de configuración.

Ubicación de esta prueba HTTP: **GIG (Río de Janeiro)**. Valores en ms:

- Redis PING: 196, 153, 160.
- Telegram getMe: 878, 883, 223.
- Doce GET consecutivos: 1552 y 1498.
- Un MGET con las mismas doce claves: 125 y 122.

Se leyeron claves inexistentes bajo `group:0:`; no se modificaron configuraciones. La media de ese lote de lecturas pasa de 1525 a 123,5 ms. Son dos rondas de una operación concreta, no un p50/p95 de producción ni una promesa de esa mejora en toda la respuesta de Telegram.

La prueba posterior del usuario dejó cuatro interacciones reales del menú desde **AMS (Ámsterdam)** de 531, 887, 532 y 843 ms, sin excepciones. El usuario confirmó que aparecen Automático y Horario manual. Esos registros corresponden a la versión intermedia `3891b0ac-1ccc-4206-8002-be3d9b83f338`; después se agruparon también las escrituras de caché, se omitió la lectura redundante de idioma y se aplicó la paginación de cinco. No se compara ese rango con el /config anterior porque son recorridos distintos.

## Métricas mantenidas

`PERFORMANCE_SAMPLE_RATE=0.1` registra aproximadamente el 10 % de los updates normales y todas las interacciones de configuración y cron. Para desactivarlo, usar `0`. La métrica `bot_performance` solo incluye clase de operación, colo, duración, cantidades de peticiones/comandos y errores de transporte. No contiene IDs, texto, nombres, claves, URLs ni tokens. Los tiempos sumados por servicio pueden superar la duración total si hay operaciones en paralelo.

## Modo nocturno en /config

Ruta: `/config` → grupo → **🌙 Modo nocturno**. El menú ofrece Automático por ciudad, Horario manual, Actualizar estado, Ayuda y Volver, incluso cuando el grupo todavía no está configurado.

Se corrigió la recepción de la respuesta privada con la ciudad/horario. La confirmación se entrega en privado con botones para volver. Se puede cancelar con el botón o `/cancel`; la conversación caduca a los 15 minutos. Los comandos y las verificaciones de canales conservan prioridad. Cada cambio comprueba de nuevo la administración del grupo.

Al guardar se revisa solamente el grupo elegido. No se reinicia artificialmente el estado de cierre: si un grupo cerrado pasa a un horario abierto se conserva la restauración de los permisos originales. El motor automático, la cola y el cron siguen siendo los existentes. El modo manual conserva el desfase GMT calculado al configurarlo; no se añade ajuste automático por horario de verano.

## Validación

- 83 pruebas aprobadas: regresiones de captcha, tópicos, permisos, enlaces, pipeline parcial, prioridad de verificaciones, conversación nocturna y paginación 5/5/2.
- TypeScript y empaquetado de Wrangler comprobados.
- El usuario confirmó el menú nocturno real.
- La mejora no añade soporte multibot: el despliegue actual continúa configurado para un solo BOT_TOKEN.

Referencias: [pipeline REST de Upstash](https://upstash.com/docs/redis/features/restapi#pipelining), [MGET](https://upstash.com/docs/redis/sdks/ts/commands/string/mget), [MSET](https://upstash.com/docs/redis/sdks/ts/commands/string/mset), [límites de Workers](https://developers.cloudflare.com/workers/platform/limits/).
