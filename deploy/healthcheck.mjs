const port = Number(process.env.PORT || 8001);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) process.exit(1);
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok || (await response.json()).status !== 'ok') process.exit(1);
} catch { process.exit(1); }
