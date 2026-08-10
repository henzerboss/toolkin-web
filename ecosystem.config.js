/**
 * PM2 держит процесс живым и поднимает его после перезагрузки сервера.
 * CloudPanel сам приложение не запускает — он только проксирует 80/443
 * на указанный ниже порт, поэтому процессом управляем мы.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup systemd -u toolkin --hp /home/toolkin
 */
module.exports = {
  apps: [
    {
      name: 'toolkin',
      script: 'npm',
      args: 'start',
      cwd: '/home/toolkin/htdocs/toolkin.app',

      // Один процесс в режиме fork — сознательно. Кластер на одном-двух ядрах
      // прироста не даёт, зато удваивает потребление памяти и усложняет логи.
      instances: 1,
      exec_mode: 'fork',

      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        // Должен совпадать с портом, указанным при создании сайта в CloudPanel.
        PORT: 3010,
      },

      error_file: '/home/toolkin/logs/toolkin-error.log',
      out_file: '/home/toolkin/logs/toolkin-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
