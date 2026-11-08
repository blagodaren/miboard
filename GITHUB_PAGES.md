# MIBoard на GitHub Pages

Открыть панель: **https://blagodaren.github.io/miboard/**.

Сайт обновляется после каждого push в `main`. Workflow
[GitHub Pages](https://github.com/blagodaren/miboard/actions/workflows/pages.yml)
проверяет типы, запускает модульные тесты и публикует сборку `dist/` со всеми
шрифтами и локальной GeoDB. Публикацию также можно запустить вручную через
**Actions → GitHub Pages → Run workflow**.

В настройках репозитория **Settings → Pages → Build and deployment → Source**
должен быть выбран **GitHub Actions**. ZIP-архивы релизов продолжают собираться
отдельным workflow Release.

## Подключить mihomo

1. Открыть сайт и ввести адрес API своего mihomo и secret.
2. Разрешить origin сайта в конфигурации mihomo:

   ```yaml
   external-controller-cors:
     allow-origins:
       - 'https://blagodaren.github.io'
     allow-private-network: true
   ```

3. Применить изменённую конфигурацию mihomo.

GitHub Pages раздаёт только панель; API остаётся на вашем устройстве.
Подключения и secret хранятся в localStorage браузера для этого origin.
Список серверов из локальной панели `/ui/` не переносится на другой origin
автоматически.

Сайт использует HTTPS. Для совместимости между браузерами API должен быть
доступен по HTTPS с доверенным сертификатом; WebSocket тогда использует WSS.
Запросы к HTTP API, например `http://192.168.1.1:9090`, могут блокироваться
как mixed content. Разрешение CORS само по себе этого не исправляет.
Для localhost и доступа к локальной сети действуют особенности браузера;
может потребоваться разрешить доступ к локальной сети.
Если HTTPS у API нет, панель можно открыть напрямую на `/ui/` ядра,
как описано в [README](README.md#подключение-к-mihomo).

Пути ресурсов уже относительные (`base: './'` в Vite), а маршруты имеют вид
`#/overview`: отдельный fallback для страниц на GitHub Pages не требуется.

Документация: [GitHub Pages с Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
[CORS mihomo](https://wiki.metacubex.one/en/config/general/#external-controller-cors),
[mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content).
