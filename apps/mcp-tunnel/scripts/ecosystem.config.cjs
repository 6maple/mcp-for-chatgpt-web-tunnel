const path = require('node:path')
const fs = require('node:fs')
const appRoot = fs.existsSync(path.join(__dirname, 'assets', 'windows-toast.ps1'))
  ? __dirname
  : path.resolve(__dirname, '..')

module.exports = {
  apps: [
    {
      name: 'mcp-tunnel',
      script: path.join(__dirname, 'start-cli.js'),
      cwd: appRoot,
      interpreter: process.execPath,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: 5000,
      exp_backoff_restart_delay: 1000,
      kill_timeout: 10000,
      out_file: path.join(appRoot, 'logs', 'tunnel.out.log'),
      error_file: path.join(appRoot, 'logs', 'tunnel.err.log'),
      merge_logs: true,
      env: {
        TUNNEL_WINDOWS_HIDE: 'true',
      },
    },
  ],
}
