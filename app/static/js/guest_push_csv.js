// CSV push manifests use VMID, host source, guest destination, optional username.
(function (root) {
  function parse(text, options = {}) {
    const rows = [];
    let row = [], field = '', quoted = false, closed = false, line = 1, rowNumber = 1;
    const source = String(text).replace(/^\uFEFF/, '');
    const finishField = () => { row.push(field); field = ''; closed = false; };
    const finishRow = () => {
      finishField();
      if (row.some(value => value.trim())) rows.push({ values: row, rowNumber });
      row = [];
    };
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
        else if (char === '"') { quoted = false; closed = true; }
        else { field += char; if (char === '\n' || (char === '\r' && source[i + 1] !== '\n')) line++; }
      } else if (char === ',') finishField();
      else if (char === '\r' || char === '\n') {
        if (char === '\r' && source[i + 1] === '\n') i++;
        finishRow();
        rowNumber = ++line;
      } else if (char === '"' && !field.trim() && !closed) { field = ''; quoted = true; }
      else if (closed && !/\s/.test(char)) throw new Error('Invalid CSV: unexpected text after a quoted field.');
      else if (!closed) field += char;
    }
    if (quoted) throw new Error('Invalid CSV: a quoted field is not closed.');
    finishRow();
    if (rows[0]?.values[0].trim().toLowerCase() === 'vmid') rows.shift();
    if (!rows.length) throw new Error('The CSV must contain at least one VMID, host source path, and guest destination path.');
    return rows.map(({ values, rowNumber }) => {
      const rawVmid = values[0].trim();
      const sourcePath = (values[1] || '').trim();
      const destinationPath = (values[2] || '').trim();
      const username = (values[3] || '').trim();
      let error = '';
      if (!/^\d+$/.test(rawVmid) || !Number.isSafeInteger(Number(rawVmid)) || Number(rawVmid) <= 0) {
        error = 'VMID must be a positive integer.';
      }
      for (const [label, path] of [['host source', sourcePath], ['guest destination', destinationPath]]) {
        if (!error && (!path.startsWith('/') || path.endsWith('/') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..'))) {
          error = `${label} must be an absolute file path, including the filename.`;
        }
      }
      const entry = { vmid: error ? rawVmid : Number(rawVmid), sourcePath, destinationPath, username };
      if (options.preview) return { ...entry, rowNumber, error };
      if (error) throw new Error(`CSV row ${rowNumber}: ${error}`);
      return entry;
    });
  }

  function matchesForVmid(vmid, groups) {
    return groups.flatMap(group => group.targets.filter(target => Number(target.vmid) === Number(vmid))
      .map(target => ({ pid: group.pid, projectName: group.projectName || group.pid, target })));
  }

  function targetError(vmid, matches) {
    return matches.length === 1 ? '' : matches.length
      ? `VMID ${vmid} matches multiple selected guests. Select guests from one Proxmox cluster.`
      : `VMID ${vmid} is not among the selected guests. Select it and refresh states if needed.`;
  }

  function plan(rows, groups) {
    const transfers = [], selectedGroups = new Map();
    for (const { vmid, sourcePath, destinationPath } of rows) {
      const matches = matchesForVmid(vmid, groups);
      const error = targetError(vmid, matches);
      if (error) throw new Error(error);
      const { pid, target } = matches[0];
      const destination = destinationPath.replace(/\/+/g, '/');
      const source = sourcePath.replace(/\/+/g, '/');
      const previous = transfers.find(item => item.pid === pid && item.vmid === vmid && item.destinationPath === destination);
      if (previous && previous.sourcePath !== source) throw new Error(`VMID ${vmid} has multiple source files for ${destination}.`);
      if (previous) continue;
      transfers.push({ pid, vmid, sourcePath: source, destinationPath: destination });
      if (!selectedGroups.has(pid)) selectedGroups.set(pid, { pid, targets: [] });
      if (!selectedGroups.get(pid).targets.includes(target)) selectedGroups.get(pid).targets.push(target);
    }
    // Preview metadata is never part of the executable guest target. In
    // particular, omit node so inventory resolution cannot use a stale node.
    return { transfers, groups: Array.from(selectedGroups.values()).map(group => ({
      pid: group.pid, targets: group.targets.map(({ index, name, type, vmid }) => ({ index, name, type, vmid })),
    })) };
  }

  function preview(text, groups) {
    const destinations = new Map();
    const guests = new Set();
    let transferCount = 0;
    const rows = parse(text, { preview: true }).map(row => {
      const matches = matchesForVmid(row.vmid, groups);
      const match = matches.length === 1 ? matches[0] : null;
      const result = {
        ...row, assignedUsername: String(match?.target.username || '').trim(),
        guestName: match?.target.name || '', node: match?.target.node || '', projectName: match?.projectName || '',
        error: row.error || targetError(row.vmid, matches), duplicate: false,
      };
      if (!result.error) {
        const key = JSON.stringify([match.pid, row.vmid, row.destinationPath.replace(/\/+/g, '/')]);
        const previous = destinations.get(key);
        if (previous && previous !== row.sourcePath.replace(/\/+/g, '/')) {
          result.error = `Multiple source files for ${row.destinationPath}.`;
        } else if (previous) result.duplicate = true;
        else {
          destinations.set(key, row.sourcePath.replace(/\/+/g, '/'));
          guests.add(JSON.stringify([match.pid, row.vmid]));
          transferCount++;
        }
      }
      result.usernameMismatch = !!(row.username && result.assignedUsername && row.username !== result.assignedUsername);
      return result;
    });
    return { rows, transferCount, guestCount: guests.size, errorCount: rows.filter(row => row.error).length,
      mismatchCount: rows.filter(row => row.usernameMismatch).length };
  }

  function renderPreview(body, result) {
    const document = body.ownerDocument;
    const fragment = document.createDocumentFragment();
    for (const row of result.rows) {
      const tr = document.createElement('tr');
      if (row.error) tr.className = 'table-danger';
      else if (row.usernameMismatch) tr.className = 'table-warning';
      const status = row.error || [row.usernameMismatch ? 'Username differs' : !row.assignedUsername ? 'No assigned username' : '',
        row.duplicate ? 'Duplicate; sent once' : ''].filter(Boolean).join(' · ') || 'Ready';
      const values = [row.rowNumber, row.vmid, row.assignedUsername || 'Unassigned', row.username || '—', row.sourcePath, row.destinationPath, status];
      values.forEach((value, index) => {
        const td = document.createElement('td');
        td.className = index === 4 || index === 5 ? 'font-monospace text-break' : 'text-break';
        if (index === 4 || index === 5) td.style.whiteSpace = 'pre-wrap';
        td.textContent = String(value);
        if (index === 2 && row.guestName) {
          const context = document.createElement('div');
          context.className = 'small text-muted';
          context.textContent = [row.guestName, row.projectName, row.node].filter(Boolean).join(' · ');
          td.append(context);
        }
        tr.append(td);
      });
      fragment.append(tr);
    }
    body.replaceChildren(fragment);
  }

  root.GuestPushCsv = { parse, plan, preview, renderPreview };
})(typeof window === 'undefined' ? globalThis : window);
