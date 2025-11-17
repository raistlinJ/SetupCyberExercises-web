(function (global) {
  function defaultCanonicalPid(value) {
    try {
      if (typeof global.canonicalPid === 'function') {
        return global.canonicalPid(value);
      }
    } catch {}
    return String(value ?? '').trim();
  }

  function defaultGetProjectSnapshot(pid) {
    try {
      if (typeof global.getProjectSnapshot === 'function') {
        return global.getProjectSnapshot(pid);
      }
    } catch {}
    return null;
  }

  function findVmConfigIndex(proj, baseName) {
    const vmList = Array.isArray(proj?.vms) ? proj.vms : [];
    const target = String(baseName || '').trim();
    if (!target) return null;
    for (let i = 0; i < vmList.length; i += 1) {
      const name = String(vmList[i]?.name || '').trim();
      if (name === target) return i;
    }
    return null;
  }

  function createHostContext(proj, vmCfg, generatedName, baseName, index, hostLabel, options = {}) {
    const canonicalize = typeof options.canonicalize === 'function' ? options.canonicalize : defaultCanonicalPid;
    const resolveIndex = typeof options.findVmConfigIndex === 'function' ? options.findVmConfigIndex : findVmConfigIndex;
    const pidRaw = proj?.id;
    const pid = canonicalize(pidRaw);
    const base = baseName || vmCfg?.name || generatedName || '';
    const vmName = vmCfg?.name || base || generatedName || '';
    const resolvedIndex = resolveIndex(proj, base);
    return {
      pid,
      pidRaw,
      vmIndex: Number.isInteger(resolvedIndex) && resolvedIndex >= 0 ? resolvedIndex : null,
      vmName,
      hostLabel: hostLabel || vmName || '',
      projectName: proj?.name || proj?.id || '',
    };
  }

  function resolveStoredCommandContextIndex(ctx, options = {}) {
    if (!ctx) return null;
    if (Number.isInteger(ctx.vmIndex) && ctx.vmIndex >= 0) {
      return ctx.vmIndex;
    }
    const canonicalize = typeof options.canonicalize === 'function' ? options.canonicalize : defaultCanonicalPid;
    const getProject = typeof options.getProjectSnapshot === 'function' ? options.getProjectSnapshot : defaultGetProjectSnapshot;
    const resolveIndex = typeof options.findVmConfigIndex === 'function' ? options.findVmConfigIndex : findVmConfigIndex;
    const pid = canonicalize(ctx.pid || ctx.pidRaw || '');
    if (!pid) return null;
    const proj = getProject(pid);
    if (!proj) return null;
    const idx = resolveIndex(proj, ctx.vmName || '');
    return Number.isInteger(idx) && idx >= 0 ? idx : null;
  }

  const api = { findVmConfigIndex, createHostContext, resolveStoredCommandContextIndex };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  try {
    global.StoredCommandCore = Object.assign(global.StoredCommandCore || {}, api);
  } catch {}
})(typeof window !== 'undefined' ? window : globalThis);
