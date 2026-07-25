// Logging boundary for public traffic. Never serialize requests, URLs, room
// snapshots, player names, bearer capabilities, tickets, or raw error stacks.

function label(value, fallback){
  const clean = String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48);
  return clean || fallback;
}

export function safeErrorEvent(event, error){
  return Object.freeze({
    event: label(event, 'worker_error'),
    errorType: label(error && error.name, 'Error'),
  });
}

export function safeMetricEvent(event, fields = {}){
  const metric = { event: label(event, 'metric') };
  for (const [key, value] of Object.entries(fields)){
    const safeKey = label(key, 'value');
    if (typeof value === 'number' && Number.isFinite(value)) metric[safeKey] = value;
    else if (typeof value === 'boolean') metric[safeKey] = value;
    else metric[safeKey] = label(value, 'unknown');
  }
  return Object.freeze(metric);
}
