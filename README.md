# MakeABuilders Wiki

Публичное содержимое официальной wiki MakeABuilders. Здесь можно исправлять существующие статьи, добавлять новые страницы и изображения, не затрагивая исходный код сайта.

## Как предложить изменение

1. Откройте нужный файл в каталоге [`articles`](articles).
2. Нажмите кнопку редактирования на GitHub.
3. Измените Markdown и создайте pull request.
4. Дождитесь автоматической проверки и ревью.

Для новой статьи скопируйте [`templates/article.md`](templates/article.md). Путь файла определяет адрес страницы:

```text
articles/start.md          → /start
articles/feature/index.md  → /feature
articles/feature/light.md  → /feature/light
```

Изображения хранятся в [`assets`](assets) и подключаются относительным путём:

```md
![Описание изображения](../../assets/example.png)
```

Подробное описание формата находится в [CONTRIBUTING.md](CONTRIBUTING.md).

## Локальная проверка

```bash
npm ci
npm test
```

Изменения появляются на сайте только после принятия pull request и очередной сборки приватного приложения.
