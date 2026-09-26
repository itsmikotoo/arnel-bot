module.exports = {
  apps: [{
    name: 'arnel-v3',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    stop_exit_codes: [10],
    kill_timeout: 45000,
    max_restarts: 10,
    env: { TZ: 'Asia/Jakarta' },
  }],
};
