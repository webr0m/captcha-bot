# Bot y Bot API en el mismo servidor

## Objetivo acordado

Reducir el tiempo de las peticiones del bot a la Bot API ejecutando ambos procesos juntos. No depender del PC del propietario. El usuario confirmó que Namecheap es un hosting compartido con cPanel; ese plan no sirve para el servidor permanente `telegram-bot-api`.

## Diseño para Cloudflare

```text
Telegram ──webhook──> Worker de entrada
                         │
                         v
                 Una instancia de Container
                 ┌───────────────────────────────────┐
                 │ Lógica actual del bot (Node)      │
                 │        │ HTTP a 127.0.0.1:8081     │
                 │ Servidor oficial telegram-bot-api │──> red de Telegram
                 └───────────────────────────────────┘
```

El Worker de entrada reenviaría HTTP y el disparador de cron. La lógica de moderación, captcha y configuración debe ejecutarse dentro del mismo contenedor que el servidor oficial. Dejar esa lógica en Workers y poner solo la API en un contenedor no cumple el objetivo de comunicación por loopback.

Usar un único Durable Object y una única instancia lógica para este bot. No distribuir una misma sesión de Telegram entre contenedores distintos. La API interna solo debe escuchar por loopback; no publicar las rutas que contienen el token del bot.

## Preparación implementada

- `TELEGRAM_API_BASE_URL` configurable por el propietario; vacío conserva `https://api.telegram.org`.
- `TelegramApi.fromEnv()` propaga la dirección a los handlers, el cron, la verificación web, los menús y los clientes por tópico.
- `http://127.0.0.1:8081` está permitido para el despliegue conjunto. HTTP hacia servidores remotos, credenciales embebidas, tokens en la URL base, parámetros y fragmentos se rechazan.
- 67 pruebas, chequeo de TypeScript y empaquetado de Workers correctos. No se ha migrado producción ni iniciado un servidor nuevo.

Esta preparación es el transporte configurable, no un servidor Bot API ya desplegado. No configurar localhost en el Worker que sigue ejecutándose en el borde: ese localhost no corresponde al contenedor.

## Requisitos pendientes

1. El usuario confirmó que utiliza Workers Free. Containers requiere Workers Paid y cobra recursos además de la suscripción base; no se contrató ni autorizó un plan nuevo. Con los alojamientos actuales no se puede desplegar el montaje conjunto solicitado.
2. Renovar la autenticación de Wrangler con permiso `containers:write`. La comprobación actual de `wrangler containers list` falla porque falta ese permiso. La sesión tampoco permite consultar las suscripciones de la cuenta, por lo que no se pudo confirmar el plan desde la API.
3. Configurar `TELEGRAM_API_ID` y `TELEGRAM_API_HASH` como secretos, obtenidos de una aplicación propia de Telegram. No son el token del bot y no deben subirse a Git.
4. Construir y probar el adaptador HTTP/cron para ejecutar la lógica actual en Node junto con `telegram-bot-api`, y su supervisor de procesos.
5. Resolver persistencia y recuperación de sesiones antes de activar el bot real. El disco de Containers es efímero; los snapshots exigen la política `durable_object`, no guardan los procesos y caducan si no se renuevan. No asumir que R2 es un disco POSIX válido para la base de datos de TDLib.
6. Probar primero con un bot de ensayo. Telegram exige `logOut` en la API anterior para garantizar la entrega de updates al migrar; volver a su API cloud tiene una espera de diez minutos tras ese método. El bot actual no se ha desconectado.

## Qué medir

La conexión por localhost elimina el tramo de red entre estos dos procesos. La conexión del servidor Bot API con Telegram y las consultas a Redis siguen existiendo.

Comparar p50/p95 de peticiones reales desde el proceso del bot, no el ping del navegador al dominio de Cloudflare. Separar tiempos de recepción del webhook, Redis, petición Bot API y respuesta visible. No anunciar una mejora de latencia hasta medirla en el despliegue elegido.

## Referencias

- [Servidor oficial de Telegram y requisitos de migración](https://github.com/tdlib/telegram-bot-api)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Precios de Containers](https://developers.cloudflare.com/containers/platform/pricing/)
- [Disco efímero y ciclo de vida](https://developers.cloudflare.com/containers/faq/)
- [Snapshots de Containers](https://developers.cloudflare.com/containers/guides/snapshots/)
- [Política de hosting compartido de Namecheap](https://www.namecheap.com/legal/hosting/aup/)
