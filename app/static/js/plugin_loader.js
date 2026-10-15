// Only load scripts for plugins explicitly enabled at application startup.
(async function () {
  try {
    const response = await fetch('/api/plugins', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not discover plugins');
    const data = await response.json();
    if (!(data.plugins || []).some(plugin => plugin.name === 'agent')) return;
    for (const source of ['/static/js/agent_transcript.js?v=20261009-auto-transcript', '/static/js/agent_plugin.js?v=20261015-agent-tabs']) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = source;
        script.onload = resolve; script.onerror = () => reject(new Error('Could not load agent plugin'));
        document.head.appendChild(script);
      });
    }
  } catch (error) { window.shell?.logError?.(error.message); }
})();
