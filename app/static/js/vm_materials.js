/* VM/LXC material links published through Proxmox Notes to AccessForge. */
(() => {
  let state = null;

  function ensureModal() {
    let modal = document.getElementById('vmMaterialsModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'vmMaterialsModal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.setAttribute('aria-labelledby', 'vmMaterialsModalLabel');
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-dialog modal-lg modal-dialog-scrollable"><div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title" id="vmMaterialsModalLabel">Manage Materials</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <form id="vm-materials-form" class="d-flex flex-column overflow-hidden" style="min-height:0">
          <div class="modal-body">
            <label class="form-label" for="vm-materials-category">Material Category (optional)</label>
            <input class="form-control mb-1" id="vm-materials-category" type="text">
            <p class="small text-muted">Groups these links in AccessForge. Leave blank to use Misc.</p>
            <p class="small text-muted">Add links to instructions, documents or hosted downloads. These appear in the AccessForge project box with this VM or LXC.</p>
            <div id="vm-materials-list"></div>
            <button class="btn btn-sm btn-outline-primary mb-3" id="vm-materials-add" type="button">Add link</button>
            <p class="small text-muted mt-1">Save these settings, then use VM Manager → Users &amp; Access → Set Metadata to apply credentials and materials to selected instances. New clones also receive these links.</p>
            <div class="alert alert-danger d-none mb-0" id="vm-materials-error" role="alert"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" type="button" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-primary" id="vm-materials-save" type="submit">Save</button>
          </div>
        </form>
      </div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('#vm-materials-add').addEventListener('click', () => {
      addRow({title: '', url: ''});
      modal.querySelector('#vm-materials-list > :last-child input').focus();
    });
    modal.querySelector('#vm-materials-form').addEventListener('submit', save);
    modal.addEventListener('hide.bs.modal', event => { if (state?.saving) event.preventDefault(); });
    modal.addEventListener('hidden.bs.modal', () => { state = null; });
    return modal;
  }

  function addRow(entry) {
    const row = document.createElement('div');
    row.className = 'border rounded p-2 mb-2';
    row.innerHTML = `
      <div class="d-flex gap-2 align-items-start">
        <div class="flex-grow-1" style="min-width:0">
          <label class="form-label small d-block">Title
            <input class="form-control form-control-sm" data-field="title" type="text" required>
          </label>
          <label class="form-label small d-block mb-0">URL
            <input class="form-control form-control-sm" data-field="url" type="url" placeholder="https://" required>
          </label>
        </div>
        <button class="btn btn-sm btn-outline-danger" type="button" aria-label="Remove link">Remove</button>
      </div>`;
    row.querySelector('[data-field="title"]').value = typeof entry.title === 'string' ? entry.title : '';
    row.querySelector('[data-field="url"]').value = typeof entry.url === 'string' ? entry.url : '';
    row.querySelector('button').addEventListener('click', () => row.remove());
    document.getElementById('vm-materials-list').appendChild(row);
  }

  function updateSummary(pid, name, idx, fields) {
    const project = (window.PROJ_CACHE || {})[pid];
    const vm = project?.vms?.find(entry => entry.name === name);
    if (vm) Object.assign(vm, fields);
    const summary = document.getElementById(`vm-${pid}-${idx}-materials-summary`);
    if (summary) {
      const count = fields.materials.length;
      summary.textContent = `${count} link${count === 1 ? '' : 's'} · ${fields.material_category || 'Misc'}`;
    }
  }

  async function save(event) {
    event.preventDefault();
    if (!state || state.saving) return;
    const modal = document.getElementById('vmMaterialsModal');
    const form = modal.querySelector('form');
    const error = modal.querySelector('#vm-materials-error');
    error.classList.add('d-none');
    if (!form.reportValidity()) return;
    const materials = [], seen = new Set();
    try {
      for (const row of modal.querySelector('#vm-materials-list').children) {
        const title = row.querySelector('[data-field="title"]').value.trim();
        const url = row.querySelector('[data-field="url"]').value.trim();
        const parsed = new URL(url);
        if (!title || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || /[\s\x00-\x1f\x7f\\]/.test(url))
          throw new Error('Each link needs a title and an absolute HTTP or HTTPS URL.');
        if (!seen.has(url)) { seen.add(url); materials.push({title, url}); }
      }
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('d-none');
      return;
    }
    const fields = {materials, material_category: modal.querySelector('#vm-materials-category').value.trim()};
    const {pid, idx, name} = state;
    state.saving = true;
    form.querySelectorAll('input,button').forEach(el => { el.disabled = true; });
    try {
      const savedProject = await saveVM(pid, name, fields, {silent: true, rethrow: true});
      const savedVm = savedProject?.vms?.find(vm => vm.name === name);
      if (!savedVm || savedVm.material_category !== fields.material_category || !Array.isArray(savedVm.materials)
          || savedVm.materials.length !== materials.length
          || !savedVm.materials.every((entry, index) => entry.title === materials[index].title && entry.url === materials[index].url)) {
        throw new Error('The server did not retain the materials settings. Restart DeployForge with the current version, then save again.');
      }
      updateSummary(pid, name, idx, {materials: savedVm.materials, material_category: savedVm.material_category});
      setVmStatus(pid, idx, 'Saved', 'text-success');
      state.saving = false;
      bootstrap.Modal.getInstance(modal)?.hide();
      if (typeof showToast === 'function') showToast('Materials saved.', 'success');
    } catch (err) {
      error.textContent = 'Could not save materials: ' + err.message;
      error.classList.remove('d-none');
      setVmStatus(pid, idx, 'Save failed', 'text-danger');
    } finally {
      if (state) state.saving = false;
      form.querySelectorAll('input,button').forEach(el => { el.disabled = false; });
    }
  }

  window.openVmMaterialsManager = (pid, idx) => {
    if (state?.saving) return;
    const vm = (window.PROJ_CACHE || {})[pid]?.vms?.[idx];
    if (!vm) return;
    const modal = ensureModal();
    state = {pid, idx, name: vm.name, saving: false};
    modal.querySelector('#vmMaterialsModalLabel').textContent = `Manage Materials — ${vm.name}`;
    modal.querySelector('#vm-materials-category').value = vm.material_category || '';
    modal.querySelector('#vm-materials-list').replaceChildren();
    for (const entry of (Array.isArray(vm.materials) ? vm.materials : [])) addRow(entry);
    modal.querySelector('#vm-materials-error').classList.add('d-none');
    bootstrap.Modal.getOrCreateInstance(modal).show();
  };
})();
