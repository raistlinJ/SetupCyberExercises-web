# VM Manager Refresh Performance Optimizations

## Current Performance Bottlenecks

After analyzing the VM refresh endpoint (`/api/projects/<pid>/instances/refresh/vm`), I've identified these bottlenecks:

### 1. **Sequential Node Processing** ⏱️ HIGH IMPACT
**Current behavior:** Nodes are processed one at a time:
```python
for n in nodes:
    node = n.get('node') or n.get('id') or ''
    qemus = client.list_qemu_vms(node)  # API call per node
```
**Impact:** If you have 3 nodes with 20ms latency each = 60ms minimum
**Solution:** Parallel processing with ThreadPoolExecutor

### 2. **Per-VM Config Fetching** ⏱️ HIGH IMPACT  
**Current behavior:** Each VM's full config is fetched individually:
```python
cfg = client.get_qemu_config(node=node, vmid=int(vmid))
```
**Impact:** With 20 VMs × 15ms each = 300ms
**Solutions:** 
- Batch config requests in parallel
- Cache template configs (they rarely change)
- Only fetch configs when needed (lazy loading)

### 3. **Pool Membership Checks** ⏱️ MEDIUM IMPACT
**Current behavior:** Multiple pool API calls per instance
**Impact:** Additional 50-100ms per project
**Solution:** Cache pool membership data

### 4. **Frontend: Single Refresh Request** ⏱️ LOW IMPACT
**Current behavior:** All projects refreshed in sequence
**Impact:** Depends on number of projects
**Solution:** Already reasonable, but could add pagination

---

## Recommended Optimizations (in priority order)

### ✅ Option 1: Parallel Node Processing (Easiest, ~50% faster)

**Estimated speedup:** 40-60% faster for multi-node clusters

**Implementation:**
```python
from concurrent.futures import ThreadPoolExecutor, as_completed

def fetch_node_vms(node_info, client_factory):
    """Fetch VMs for a single node"""
    node = node_info.get('node') or node_info.get('id') or ''
    if not node:
        return (node, [], None)
    try:
        # Use client_factory to avoid sharing session across threads
        qemus = client_factory().list_qemu_vms(node)
        return (node, qemus, None)
    except Exception as e:
        return (node, [], e)

# In instances_refresh_vm():
nodes = client.list_nodes()
name_map = {}
id_map = {}
lower_name_to_canon = {}

# Fetch all nodes in parallel
with ThreadPoolExecutor(max_workers=min(len(nodes), 8)) as executor:
    # Use lambda to create client per thread (sessions aren't thread-safe)
    client_factory = lambda: ProxmoxClient(base_url=base_url, token=token, username=username, password=password, verify=verify)
    
    futures = [executor.submit(fetch_node_vms, n, client_factory) for n in nodes]
    
    for future in as_completed(futures):
        node, qemus, error = future.result()
        if error:
            logging.warning(f"Could not list VMs on node {node}: {error}")
            continue
        
        # Build maps (same logic as before)
        for q in qemus:
            name = (q.get('name') or q.get('vmid'))
            if not name:
                continue
            vmid_val = int(q.get('vmid')) if q.get('vmid') is not None else None
            if vmid_val is not None:
                id_map[vmid_val] = str(q.get('name') or vmid_val)
            canon = str(name)
            name_map[canon] = {
                'node': node,
                'vmid': vmid_val,
                'state': q.get('status') or q.get('qmpstatus') or ''
            }
            lower_name_to_canon[canon.lower()] = canon
```

**Pros:** 
- Easy to implement
- Thread-safe (each thread gets own client)
- Works with existing Proxmox API
- No schema changes needed

**Cons:**
- Need to handle thread-local client sessions
- Still limited by slowest node

---

### ✅ Option 2: Parallel Config Fetching (~30% faster)

**Estimated speedup:** 25-40% faster for config-heavy operations

Currently around line 530-560, configs are fetched one at a time. Parallelize:

```python
def fetch_vm_config(node, vmid, client_factory):
    """Fetch a single VM config"""
    try:
        cfg = client_factory().get_qemu_config(node=node, vmid=int(vmid))
        return (vmid, cfg, None)
    except Exception as e:
        return (vmid, None, e)

# When fetching configs for template detection:
config_futures = []
with ThreadPoolExecutor(max_workers=min(len(found_details), 12)) as executor:
    for fd in found_details:
        if fd.get('vmid') and fd.get('node'):
            future = executor.submit(fetch_vm_config, fd['node'], fd['vmid'], client_factory)
            config_futures.append((future, fd))
    
    for future, fd in config_futures:
        vmid, cfg, error = future.result()
        if cfg:
            # Extract template info
            fd['template_name'] = ...
            fd['template_id'] = ...
            fd['nets'] = _extract_nets(cfg)
```

---

### ✅ Option 3: Config Caching (Best for repeated refreshes)

**Estimated speedup:** 60-90% faster for auto-refresh scenarios

**Implementation:** Add in-memory cache with TTL:

```python
from functools import lru_cache
from datetime import datetime, timedelta

# Cache VM configs for 60 seconds (templates rarely change)
_config_cache = {}
_cache_ttl = timedelta(seconds=60)

def get_cached_config(client, node, vmid, force_refresh=False):
    """Get VM config with caching"""
    cache_key = f"{node}:{vmid}"
    now = datetime.now()
    
    if not force_refresh and cache_key in _config_cache:
        cached_time, cached_cfg = _config_cache[cache_key]
        if now - cached_time < _cache_ttl:
            return cached_cfg
    
    # Fetch fresh
    cfg = client.get_qemu_config(node=node, vmid=int(vmid))
    _config_cache[cache_key] = (now, cfg)
    return cfg

# Use in refresh endpoint:
cfg = get_cached_config(client, node, vmid)
```

**Pros:**
- Huge speedup for auto-refresh
- Reduces Proxmox API load
- Easy to implement

**Cons:**
- Cache invalidation complexity
- Memory usage (minimal)
- Stale data risk (acceptable for 60s TTL)

---

### ✅ Option 4: Lazy Loading (Frontend optimization)

**Current:** All VM details loaded upfront  
**Proposed:** Load basic status first, then fetch details on demand

```javascript
// In vm_manager.js, add a "detail_level" parameter
const body = { 
  username: sess.username,
  password: sess.password,
  baseUrl: p.proxmox_url,
  apiPort: p.proxmox_api_port,
  verifySSL: p.proxmox_verify_ssl !== false,
  detail_level: 'basic'  // or 'full'
};

// Basic: only fetch VM list and state (no configs)
// Full: fetch everything (current behavior)
```

Backend modification:
```python
@api_bp.route("/projects/<pid>/instances/refresh/vm", methods=["POST"])
def instances_refresh_vm(pid: str):
    # ... existing code ...
    detail_level = body.get('detail_level', 'full')
    
    if detail_level == 'basic':
        # Skip template detection and network extraction
        # Only return name, vmid, state, node
        pass
    else:
        # Full refresh (current behavior)
        pass
```

**Pros:**
- Fast initial load
- Better UX (progressive enhancement)
- Reduces unnecessary API calls

**Cons:**
- More complex frontend logic
- Need expandable rows for details

---

### ✅ Option 5: Pool Caching

**Current:** Pool membership checked every refresh  
**Proposed:** Cache pool data for 2-5 minutes

```python
_pool_cache = {}  # {poolid: (timestamp, member_vmids)}

def get_cached_pool_members(client, poolid, ttl_seconds=120):
    """Get pool members with caching"""
    now = datetime.now()
    
    if poolid in _pool_cache:
        cached_time, members = _pool_cache[poolid]
        if now - cached_time < timedelta(seconds=ttl_seconds):
            return members
    
    # Fetch fresh
    try:
        result = client.list_pool_members(poolid)
        members = set(int(m['vmid']) for m in result if 'vmid' in m)
    except Exception:
        members = set()
    
    _pool_cache[poolid] = (now, members)
    return members
```

---

## Quick Wins (Implement These First)

### 1. Add Parallel Node Fetching
- **File:** `app/routes/api.py` (lines 448-470)
- **Time:** 15-20 minutes
- **Impact:** ~50% faster

### 2. Add Config Caching
- **File:** `app/routes/api.py` (top of file)
- **Time:** 10-15 minutes  
- **Impact:** ~70% faster for auto-refresh

### 3. Show Progress During Refresh
- **File:** `app/static/js/vm_manager.js`
- **Already implemented!** ✅ (lines 407-423)

---

## Testing Performance

### Measure Before & After:
```javascript
// In vm_manager.js, add timing:
async function refreshVmView() {
  const t0 = performance.now();
  // ... existing code ...
  const t1 = performance.now();
  console.log(`VM refresh took ${(t1-t0).toFixed(0)}ms`);
}
```

### Expected Results:
- **Before:** 500-2000ms (depends on # of VMs/nodes)
- **After Option 1:** 300-1000ms
- **After Option 1+2:** 200-600ms  
- **After Option 1+2+3:** 50-200ms (with cache hits)

---

## Monitoring & Logging

Add timing logs to backend:
```python
import time

@api_bp.route("/projects/<pid>/instances/refresh/vm", methods=["POST"])
def instances_refresh_vm(pid: str):
    t_start = time.time()
    
    # ... existing code ...
    
    t_end = time.time()
    logging.info(f"VM refresh for project {pid} took {(t_end-t_start)*1000:.0f}ms")
    return jsonify({ 'instance_statuses': out })
```

---

## Implementation Priority

**Phase 1 (Quick Wins - 30 min):**
1. ✅ Parallel node fetching
2. ✅ Config caching with 60s TTL
3. ✅ Add timing logs

**Phase 2 (Enhanced - 1-2 hours):**
4. Parallel config fetching
5. Pool caching
6. Frontend timing display

**Phase 3 (Advanced - 2-4 hours):**
7. Lazy loading with detail levels
8. Cache invalidation on VM actions
9. WebSocket real-time updates (future)

---

## Cache Invalidation Strategy

**When to clear cache:**
- After VM create/delete/clone operations
- Manual "Force Refresh" button
- On project switch
- After 60 seconds (automatic TTL)

```python
def clear_vm_cache(project_id=None):
    """Clear cached VM data"""
    global _config_cache, _pool_cache
    if project_id:
        # Clear only specific project's VMs
        keys_to_delete = [k for k in _config_cache.keys() if f"proj_{project_id}" in k]
        for k in keys_to_delete:
            del _config_cache[k]
    else:
        # Clear all
        _config_cache.clear()
        _pool_cache.clear()
```

Call this in create/delete/clone endpoints.

---

## Summary

**Implement Options 1 + 2 + 3** for the best balance of:
- Development time (~1 hour)
- Performance gain (3-5x faster)
- Maintainability (minimal complexity)
- User experience (responsive UI)

The caching approach (Option 3) is especially powerful for auto-refresh scenarios where the same data is fetched repeatedly.
