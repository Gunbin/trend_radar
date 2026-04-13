const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
};

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
    info: (msg) => console.log(`${colors.dim}[${getTimestamp()}]${colors.reset} ${colors.blue}[INFO]${colors.reset} ${msg}`),
    success: (msg) => console.log(`${colors.dim}[${getTimestamp()}]${colors.reset} ${colors.green}[SUCCESS]${colors.reset} ${msg}`),
    warn: (msg) => console.warn(`${colors.dim}[${getTimestamp()}]${colors.reset} ${colors.yellow}[WARN]${colors.reset} ${msg}`),
    error: (msg, err = '') => console.error(`${colors.dim}[${getTimestamp()}]${colors.reset} ${colors.red}[ERROR]${colors.reset} ${msg}`, err ? `\n${colors.red}${err}${colors.reset}` : ''),
    process: (msg) => console.log(`${colors.dim}[${getTimestamp()}]${colors.reset} ${colors.magenta}[PROCESS]${colors.reset} ${colors.bright}${msg}${colors.reset}`),
    api: (msg) => console.log(`${colors.dim}[${getTimestamp()}]${colors.reset} ${colors.cyan}[API]${colors.reset} ${msg}`),
};

export default logger;
