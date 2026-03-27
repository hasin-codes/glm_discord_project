let batchId = 'no-batch';

function setBatchId(id) {
  batchId = id;
}

function log(level, step, message, data = {}) {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    batchId,
    step,
    message,
    ...data,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const logger = {
  info: (step, message, data) => log('info', step, message, data),
  warn: (step, message, data) => log('warn', step, message, data),
  error: (step, message, data) => log('error', step, message, data),
  setBatchId,
};

module.exports = logger;
