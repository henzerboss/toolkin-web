import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Поддержка — Toolkin' };

export default function Support() {
  return (
    <main className="doc">
      <Link href="/" className="wordmark">
        toolkin
      </Link>
      <h1>Поддержка</h1>
      <p>
        Пишите на <a href="mailto:hello@toolkin.app">hello@toolkin.app</a> — отвечаем
        в течение рабочего дня.
      </p>

      <h2>Утилита получилась не такой, как я просил</h2>
      <p>
        Откройте её и нажмите «Изменить» — опишите, что поправить. Прошлая версия
        сохраняется, к ней всегда можно вернуться в истории версий.
      </p>

      <h2>Куда делись кредиты</h2>
      <p>
        Создание утилиты стоит 5 кредитов, правка — 2, обращение к модели внутри
        утилиты — 1. Неудачная генерация не списывает ничего. Текущий баланс и цены
        видны в настройках.
      </p>

      <h2>Я переустановил приложение и потерял кредиты</h2>
      <p>
        Подписка возвращается кнопкой «Восстановить покупки». Купленные кредиты
        привязаны к устройству — напишите нам, мы восстановим баланс вручную. Чтобы
        это не повторилось, привяжите аккаунт Apple или Google в настройках.
      </p>

      <h2>Возврат средств</h2>
      <p>
        Возвраты обрабатывают Apple и Google, а не мы. Для App Store —{' '}
        <a href="https://reportaproblem.apple.com">reportaproblem.apple.com</a>, для
        Google Play — раздел заказов в приложении Play Store.
      </p>

      <hr />
      <footer>
        <Link href="/">На главную</Link>
        <Link href="/privacy">Конфиденциальность</Link>
      </footer>
    </main>
  );
}
