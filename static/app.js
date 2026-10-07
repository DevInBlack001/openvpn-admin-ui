// Every state-changing request carries the session's CSRF token, which the
// server compares with the one it issued for this session.
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || '';
const nativeFetch = window.fetch.bind(window);
window.fetch = (resource, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        options = { ...options, headers: { ...(options.headers || {}), 'X-CSRF-Token': CSRF_TOKEN } };
    }
    return nativeFetch(resource, options);
};

let clientsData = [];
let defaultDNVals = null;
let cachedLogs = [];
let cachedLogsSignature = '';
let activeLogTab = 'all';
let activeSeverityFilter = 'all';
let activePage = 'dashboardPage';
let uiUsersData = [];
let revealedPasswords = new Set();
let statsInterval = null;
let clientsInterval = null;
let logsInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }

    switchPage(activePage);
    initFormHandlers();
    
    fetchCAStatus();
    fetchClients();
    startPolling();

    // Scrolling back to the top of the log table resumes live updates.
    document.getElementById('logTableScroll')?.addEventListener('scroll', (e) => {
        const pill = document.getElementById('logPausedPill');
        if (e.target.scrollTop <= 4 && pill && !pill.classList.contains('hidden')) {
            jumpToLatestLogs();
        }
    });
});

function startPolling() {
    stopPolling();
    fetchSystemStats();
    fetchHostStats();

    statsInterval = setInterval(() => {
        fetchSystemStats();
        fetchHostStats();
    }, 2000);
    clientsInterval = setInterval(fetchClients, 2000);
    
    logsInterval = setInterval(() => {
        if (activePage === 'logsPage') {
            fetchLogs();
        }
    }, 2000);
}

function stopPolling() {
    if (statsInterval) clearInterval(statsInterval);
    if (clientsInterval) clearInterval(clientsInterval);
    if (logsInterval) clearInterval(logsInterval);
}

function switchPage(pageId) {
    activePage = pageId;
    
    document.querySelectorAll('.page-view').forEach(view => {
        view.classList.add('hidden');
    });
    
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    const activeView = document.getElementById(pageId);
    if (activeView) activeView.classList.remove('hidden');

    const activeTab = document.querySelector(`.nav-tab[data-page="${pageId}"]`);
    if (activeTab) activeTab.classList.add('active');

    if (pageId === 'userManagementPage') {
        fetchUIUsers();
    } else if (pageId === 'logsPage') {
        fetchLogs(true);
    }
}

function toggleTheme() {
    const body = document.body;
    body.classList.toggle('light-theme');
    const isLight = body.classList.contains('light-theme');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

function fetchSystemStats() {
    let activeTunnels = 0;
    let totalProfiles = clientsData.length;
    
    clientsData.forEach(client => {
        if (client.connected) {
            const devCount = client.devices ? client.devices.length : 1;
            activeTunnels += devCount;
        }
    });

    document.getElementById('activeConnsStat').textContent = activeTunnels;
    document.getElementById('totalClientsStat').textContent = totalProfiles;
}

function fetchHostStats() {
    const show = (id, value) => {
        document.getElementById(id).textContent =
            (value === null || value === undefined) ? '--%' : `${Math.round(value)}%`;
    };
    fetch('/api/system/stats')
        .then(res => res.json())
        .then(data => {
            show('cpuUsageStat', data.cpu_percent);
            show('ramUsageStat', data.memory_percent);
        })
        .catch(() => {
            show('cpuUsageStat', null);
            show('ramUsageStat', null);
        });
}

function fetchCAStatus() {
    fetch('/api/ca/defaults')
        .then(res => res.json())
        .then(data => {
            defaultDNVals = data;
            populateDefaults();
        })
        .catch(err => console.error("Error fetching CA defaults:", err));
}

function fetchClients() {
    fetch('/api/clients')
        .then(res => {
            if (res.status === 401 || res.redirected) {
                window.location.href = '/login';
                return [];
            }
            return res.json();
        })
        .then(data => {
            clientsData = data;
            renderClients(data);
            fetchSystemStats();
        })
        .catch(err => console.error("Error fetching client profiles:", err));
}

function renderClients(clients) {
    const tbody = document.getElementById('clientTableBody');
    if (!tbody) return;
    
    const searchVal = document.getElementById('clientSearchInput').value.toLowerCase().strip();
    
    const filtered = clients.filter(c => {
        if (!searchVal) return true;
        return (c.username && c.username.toLowerCase().includes(searchVal)) ||
               (c.name && c.name.toLowerCase().includes(searchVal)) ||
               (c.real_address && c.real_address.toLowerCase().includes(searchVal)) ||
               (c.virtual_address && c.virtual_address.toLowerCase().includes(searchVal));
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="11" class="text-center py-4 text-secondary">
                    No client profiles found.
                </td>
            </tr>
        `;
        return;
    }
    
    tbody.innerHTML = '';
    const currentRole = document.getElementById('currentUserDisplay')?.getAttribute('data-role') || 'user';
    
    filtered.forEach(client => {
        const tr = document.createElement('tr');
        const safeName = escapeHtml(client.name);

        let statusBadge = '';
        if (client.status === 'Valid') {
            statusBadge = `<span class="badge badge-success">Valid</span>`;
        } else if (client.status === 'Revoked') {
            statusBadge = `<span class="badge badge-danger">Revoked</span>`;
        } else {
            statusBadge = `<span class="badge badge-warning">Expired</span>`;
        }
        
        let connectionStatus = '';
        if (client.connected) {
            const devCount = client.devices ? client.devices.length : 1;
            connectionStatus = `<span class="status-dot status-dot-active"></span>Connected (${devCount})`;
        } else {
            connectionStatus = `<span class="status-dot status-dot-inactive"></span>Offline`;
        }
        
        let bandwidth = '-';
        if (client.connected && (client.bytes_received || client.bytes_sent)) {
            const rx = formatBytes(client.bytes_received);
            const tx = formatBytes(client.bytes_sent);
            bandwidth = `<span class="text-muted">↓</span> ${rx}<br><span class="text-muted">↑</span> ${tx}`;
        }
        
        let actionButtons = '';
        if (currentRole === 'admin') {
            if (client.status === 'Valid') {
                actionButtons = `
                    <div class="actions-cell-wrapper">
                        <button class="btn btn-secondary btn-sm" data-name="${safeName}" onclick="downloadClient(this.dataset.name)" title="Download Configuration">
                            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z" /></svg>
                        </button>
                        <button class="btn btn-danger btn-sm" data-name="${safeName}" onclick="confirmRevokeClient(this.dataset.name)" title="Revoke Certificate">
                            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12,2C17.52,2 22,6.48 22,12C22,17.52 17.52,22 12,22C6.48,22 2,17.52 2,12C2,6.48 6.48,2 12,2M12,4C7.58,4 4,7.58 4,12C4,16.42 7.58,20 12,20C16.42,20 20,16.42 20,12C20,7.58 16.42,4 12,4M12,6C14.21,6 16,7.79 16,10C16,12.21 14.21,14 12,14C9.79,14 8,12.21 8,10C8,7.79 9.79,6 12,6M12,8C10.9,8 10,8.9 10,10C10,11.1 10.9,12 12,12C13.1,12 14,11.1 14,10C14,8.9 13.1,8 12,8Z" /></svg>
                        </button>
                    </div>
                `;
            } else {
                actionButtons = `
                    <div class="actions-cell-wrapper">
                        <button class="btn btn-danger btn-sm" data-name="${safeName}" onclick="confirmDeleteClient(this.dataset.name)" title="Delete Profile">
                            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" /></svg>
                        </button>
                    </div>
                `;
            }
        } else {
            if (client.status === 'Valid') {
                actionButtons = `
                    <div class="actions-cell-wrapper">
                        <button class="btn btn-secondary btn-sm" data-name="${safeName}" onclick="downloadClient(this.dataset.name)" title="Download Configuration">
                            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z" /></svg>
                        </button>
                    </div>
                `;
            } else {
                actionButtons = `<span class="text-muted">None</span>`;
            }
        }
        
        let limitLabel = '-';
        if (client.limit === 0) {
            limitLabel = 'Unlimited';
        } else if (client.limit !== undefined) {
            limitLabel = client.limit;
        }
        
        const formatIPs = (ipString) => {
            if (!ipString || ipString === '-') return '-';
            return ipString.split(', ').map(escapeHtml).join('<br>');
        };

        // One "address:port" line per connected device.
        let realAddress = '-';
        if (client.devices && client.devices.length) {
            realAddress = client.devices.map(d => escapeHtml(`${d.real_address}:${d.port}`)).join('<br>');
        }

        const expiryDate = (client.expiry || '-').split(' ')[0];

        const isPasswordRevealed = revealedPasswords.has(client.name);
        const passwordDisplay = isPasswordRevealed ? escapeHtml(client.password || '-') : '••••••••';
        const passwordBg = isPasswordRevealed ? 'rgba(128,128,128,0.2)' : 'rgba(128,128,128,0.1)';
        
        tr.innerHTML = `
            <td class="client-name-cell" title="${escapeHtml(client.username)}">${escapeHtml(client.username || '-')}</td>
            <td class="client-cn-cell" title="${safeName}">${safeName}</td>
            <td>${statusBadge}</td>
            <td title="${escapeHtml(client.expiry)}">${escapeHtml(expiryDate)}</td>
            <td>${connectionStatus}</td>
            <td style="text-align: center;">${escapeHtml(limitLabel)}</td>
            <td>${client.password === null
                ? '<span class="text-muted" title="Visible to administrators">Hidden</span>'
                : `<span class="password-cell" data-name="${safeName}" onclick="togglePasswordReveal(this, this.dataset.name)" data-password="${escapeHtml(client.password || '-')}" style="cursor: pointer; font-family: monospace; background: ${passwordBg}; padding: 4px 8px; border-radius: 4px; font-size: 0.8125rem;">${passwordDisplay}</span>`}</td>
            <td class="ip-cell">${realAddress}</td>
            <td class="ip-cell">${formatIPs(client.virtual_address)}</td>
            <td>${bandwidth}</td>
            <td class="actions-col">${actionButtons}</td>
        `;
        
        tbody.appendChild(tr);
    });
}

function filterClientsTable() {
    renderClients(clientsData);
}

function togglePasswordReveal(el, clientName) {
    const password = el.getAttribute('data-password');
    if (revealedPasswords.has(clientName)) {
        revealedPasswords.delete(clientName);
        el.textContent = '••••••••';
        el.style.background = 'rgba(128,128,128,0.1)';
    } else {
        revealedPasswords.add(clientName);
        el.textContent = password;
        el.style.background = 'rgba(128,128,128,0.2)';
    }
}

function generateRandomPassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
    // 64 symbols divide 256 evenly, so each random byte maps to a symbol without bias.
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    let pass = '';
    bytes.forEach(b => { pass += chars.charAt(b % chars.length); });
    document.getElementById('clientPasswordInput').value = pass;
}

function openModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
    if (modalId === 'createModal') {
        populateDefaults();
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

function populateDefaults() {
    if (!defaultDNVals) return;
    document.getElementById('dnCountry').value = defaultDNVals.country || '';
    document.getElementById('dnProvince').value = defaultDNVals.province || '';
    document.getElementById('dnCity').value = defaultDNVals.city || '';
    document.getElementById('dnOrg').value = defaultDNVals.org || '';
    document.getElementById('dnOU').value = defaultDNVals.ou || '';
    document.getElementById('dnEmail').value = defaultDNVals.email || '';
}

function initFormHandlers() {
    const createForm = document.getElementById('createClientForm');
    createForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const submitBtn = document.getElementById('btnCreateClientSubmit');
        const spinner = document.getElementById('createSpinner');
        const errDiv = document.getElementById('createError');
        
        submitBtn.disabled = true;
        spinner.classList.remove('hidden');
        errDiv.classList.add('hidden');
        
        const payload = {
            name: document.getElementById('clientNameInput').value.trim(),
            username: document.getElementById('clientUsernameInput').value.trim(),
            password: document.getElementById('clientPasswordInput').value.trim(),
            limit: parseInt(document.getElementById('clientLimitInput').value),
            country: document.getElementById('dnCountry').value.trim(),
            province: document.getElementById('dnProvince').value.trim(),
            city: document.getElementById('dnCity').value.trim(),
            org: document.getElementById('dnOrg').value.trim(),
            ou: document.getElementById('dnOU').value.trim(),
            email: document.getElementById('dnEmail').value.trim()
        };
        
        fetch('/api/clients/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(res => res.json().then(data => ({ status: res.status, data })))
        .then(({ status, data }) => {
            if (status !== 200) {
                throw new Error(data.error || "Creation failed");
            }
            
            showToast("Client profile created successfully");
            closeModal('createModal');
            createForm.reset();
            fetchClients();
        })
        .catch(err => {
            errDiv.textContent = err.message;
            errDiv.classList.remove('hidden');
        })
        .finally(() => {
            submitBtn.disabled = false;
            spinner.classList.add('hidden');
        });
    });

    const createUserForm = document.getElementById('createUserForm');
    createUserForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        const errDiv = document.getElementById('createUserError');
        errDiv.classList.add('hidden');
        
        const payload = {
            username: document.getElementById('uiUsernameInput').value.trim(),
            password: document.getElementById('uiPasswordInput').value.trim(),
            role: document.getElementById('uiRoleInput').value
        };
        
        fetch('/api/ui-users/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(res => res.json().then(data => ({ status: res.status, data })))
        .then(({ status, data }) => {
            if (status !== 200) throw new Error(data.error || "Failed to create user");
            showToast("UI User created successfully");
            closeModal('createUserModal');
            createUserForm.reset();
            fetchUIUsers();
        })
        .catch(err => {
            errDiv.textContent = err.message;
            errDiv.classList.remove('hidden');
        });
    });

    const editUserForm = document.getElementById('editUserForm');
    editUserForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        const errDiv = document.getElementById('editUserError');
        errDiv.classList.add('hidden');
        
        const payload = {
            username: document.getElementById('editUiUsernameInput').value,
            password: document.getElementById('editUiPasswordInput').value.trim(),
            role: document.getElementById('editUiRoleInput').value
        };
        
        fetch('/api/ui-users/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(res => res.json().then(data => ({ status: res.status, data })))
        .then(({ status, data }) => {
            if (status !== 200) throw new Error(data.error || "Failed to update user");
            showToast("UI User updated successfully");
            closeModal('editUserModal');
            editUserForm.reset();
            fetchUIUsers();
        })
        .catch(err => {
            errDiv.textContent = err.message;
            errDiv.classList.remove('hidden');
        });
    });
}

function downloadClient(name) {
    window.location.href = `/api/clients/download/${encodeURIComponent(name)}`;
}

function confirmRevokeClient(name) {
    const actionBtn = document.getElementById('confirmActionBtn');
    
    document.getElementById('confirmTitle').textContent = "Revoke Client Certificate";
    document.getElementById('confirmMessage').textContent = `Are you sure you want to revoke the certificate for '${name}'? This will permanently disable their connection capability.`;
    
    actionBtn.onclick = () => {
        actionBtn.disabled = true;
        fetch('/api/clients/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        })
        .then(res => res.json().then(data => ({ status: res.status, data })))
        .then(({ status, data }) => {
            if (status !== 200) throw new Error(data.error || "Failed to revoke client");
            showToast(`Certificate '${name}' revoked successfully`);
            closeModal('confirmModal');
            fetchClients();
        })
        .catch(err => {
            alert(err.message);
        })
        .finally(() => {
            actionBtn.disabled = false;
        });
    };
    
    openModal('confirmModal');
}

function confirmDeleteClient(name) {
    const actionBtn = document.getElementById('confirmActionBtn');
    
    document.getElementById('confirmTitle').textContent = "Delete Client Profile";
    document.getElementById('confirmMessage').textContent = `Are you sure you want to delete '${name}'? This removes their configuration files and credentials from the dashboard UI.`;
    
    actionBtn.onclick = () => {
        actionBtn.disabled = true;
        fetch('/api/clients/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        })
        .then(res => res.json().then(data => ({ status: res.status, data })))
        .then(({ status, data }) => {
            if (status !== 200) throw new Error(data.error || "Failed to delete client");
            showToast(`Profile '${name}' deleted successfully`);
            closeModal('confirmModal');
            fetchClients();
        })
        .catch(err => {
            alert(err.message);
        })
        .finally(() => {
            actionBtn.disabled = false;
        });
    };
    
    openModal('confirmModal');
}

function fetchUIUsers() {
    fetch('/api/ui-users')
        .then(res => res.json())
        .then(data => {
            uiUsersData = data;
            renderUIUsers(data);
        })
        .catch(err => console.error("Error fetching UI users:", err));
}

function renderUIUsers(users) {
    const tbody = document.getElementById('uiUserTableBody');
    if (!tbody) return;
    
    if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-center py-4">No portal users found.</td></tr>`;
        return;
    }
    
    tbody.innerHTML = '';
    const currentUsername = document.getElementById('currentUserDisplay')?.getAttribute('data-username') || '';
    
    users.forEach(user => {
        const tr = document.createElement('tr');
        const userAttrs = `data-username="${escapeHtml(user.username)}" data-role="${escapeHtml(user.role)}"`;

        let actionButtons = '';
        if (user.username !== currentUsername) {
            actionButtons = `
                <div class="actions-cell-wrapper">
                    <button class="btn btn-secondary btn-sm" ${userAttrs} onclick="openEditUserModal(this.dataset.username, this.dataset.role)">
                        Edit
                    </button>
                    <button class="btn btn-danger btn-sm" ${userAttrs} onclick="confirmDeleteUIUser(this.dataset.username)">
                        Delete
                    </button>
                </div>
            `;
        } else {
            actionButtons = `
                <div class="actions-cell-wrapper">
                    <button class="btn btn-secondary btn-sm" ${userAttrs} onclick="openEditUserModal(this.dataset.username, this.dataset.role)">
                        Edit Password
                    </button>
                    <span class="text-muted" style="margin-left: 8px; font-size: 0.8125rem;">(Active Account)</span>
                </div>
            `;
        }
        
        tr.innerHTML = `
            <td><strong>${escapeHtml(user.username)}</strong></td>
            <td><span class="badge ${user.role === 'admin' ? 'badge-danger' : 'badge-warning'}">${escapeHtml(user.role.toUpperCase())}</span></td>
            <td class="actions-col">${actionButtons}</td>
        `;
        
        tbody.appendChild(tr);
    });
}

function openEditUserModal(username, role) {
    document.getElementById('editUiUsernameInput').value = username;
    document.getElementById('editUiRoleInput').value = role;
    document.getElementById('editUiPasswordInput').value = '';
    
    const currentUsername = document.getElementById('currentUserDisplay')?.getAttribute('data-username') || '';
    if (username === currentUsername) {
        document.getElementById('editUiRoleInput').disabled = true;
    } else {
        document.getElementById('editUiRoleInput').disabled = false;
    }
    
    openModal('editUserModal');
}

function confirmDeleteUIUser(username) {
    const actionBtn = document.getElementById('confirmActionBtn');
    
    document.getElementById('confirmTitle').textContent = "Delete UI Administrator Account";
    document.getElementById('confirmMessage').textContent = `Are you sure you want to delete the portal access account for '${username}'? They will immediately lose dashboard access.`;
    
    actionBtn.onclick = () => {
        actionBtn.disabled = true;
        fetch('/api/ui-users/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        })
        .then(res => res.json().then(data => ({ status: res.status, data })))
        .then(({ status, data }) => {
            if (status !== 200) throw new Error(data.error || "Failed to delete UI user");
            showToast(`User '${username}' deleted successfully`);
            closeModal('confirmModal');
            fetchUIUsers();
        })
        .catch(err => {
            alert(err.message);
        })
        .finally(() => {
            actionBtn.disabled = false;
        });
    };
    
    openModal('confirmModal');
}

const LOG_CATEGORY_LABELS = {
    traffic: 'Connections',
    auth: 'Authentication',
    tls: 'TLS Security',
    general: 'General'
};

// Newest entries are at the top. `force` is for a change the user made (tab,
// filter, refresh): it redraws and returns to the top. The background poll
// passes nothing and holds the table still while the user is scrolled into older rows.
function fetchLogs(force = false) {
    const limit = document.getElementById('logLimitSelector').value;
    const timeframe = document.getElementById('logTimeframeSelector')?.value || 'all';
    const verbose = document.getElementById('logVerboseToggle')?.checked ? '1' : '0';

    fetch(`/api/logs?category=${activeLogTab}&severity=${activeSeverityFilter}&limit=${limit}&timeframe=${timeframe}&verbose=${verbose}`)
        .then(res => res.json())
        .then(data => {
            const signature = JSON.stringify(data);
            const changed = signature !== cachedLogsSignature;
            cachedLogs = data;
            cachedLogsSignature = signature;

            const scrollEl = document.getElementById('logTableScroll');
            const readingOlderRows = scrollEl && scrollEl.scrollTop > 4;

            if (force) {
                renderLogsTable(data);
                if (scrollEl) scrollEl.scrollTop = 0;
                setLogsPaused(false);
            } else if (readingOlderRows) {
                if (changed) setLogsPaused(true);
            } else if (changed) {
                renderLogsTable(data);
            }
        })
        .catch(err => console.error("Error fetching logs:", err));
}

function setLogsPaused(paused) {
    document.getElementById('logPausedPill')?.classList.toggle('hidden', !paused);
}

function jumpToLatestLogs() {
    renderLogsTable(cachedLogs);
    const scrollEl = document.getElementById('logTableScroll');
    if (scrollEl) scrollEl.scrollTop = 0;
    setLogsPaused(false);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function filterLogsBySearch(logs) {
    const searchVal = document.getElementById('logSearchInput').value.toLowerCase();
    if (!searchVal) return logs;
    const searchable = ['text', 'event', 'user', 'cert_cn', 'virtual_ip', 'client', 'platform'];
    return logs.filter(log =>
        searchable.some(field => (log[field] || '').toLowerCase().includes(searchVal))
    );
}

function renderLogsTable(logs) {
    const tbody = document.getElementById('logTableBody');
    if (!tbody) return;

    const filtered = filterLogsBySearch(logs);

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="log-empty">No matching log records found.</td></tr>`;
        return;
    }

    const muted = '<span class="text-muted">-</span>';
    const cell = (value) => value ? escapeHtml(value) : muted;

    tbody.innerHTML = filtered.map(log => {
        let sevBadge = 'badge-info';
        if (log.severity === 'WARNING') sevBadge = 'badge-warning';
        if (log.severity === 'ERROR') sevBadge = 'badge-danger';

        const source = log.ip
            ? `<span class="log-ip">${escapeHtml(log.ip)}</span><span class="log-port">:${escapeHtml(log.port)}</span>`
            : muted;

        return `
            <tr class="log-row log-row-${escapeHtml(log.severity.toLowerCase())}" onclick="toggleLogRaw(this)" title="Click to show the original log line">
                <td class="log-col-time">${cell(log.time)}</td>
                <td><span class="badge ${sevBadge}">${escapeHtml(log.severity)}</span></td>
                <td class="log-col-category">${escapeHtml(LOG_CATEGORY_LABELS[log.category] || log.category)}</td>
                <td class="log-col-event">${escapeHtml(log.event)}</td>
                <td class="log-col-user" title="${escapeHtml(log.user)}">${cell(log.user)}</td>
                <td class="log-col-mono">${cell(log.cert_cn)}</td>
                <td class="log-col-mono">${source}</td>
                <td class="log-col-mono">${cell(log.virtual_ip)}</td>
                <td class="log-col-client" title="${escapeHtml([log.client, log.platform].filter(Boolean).join(' / '))}">${cell(log.client || log.platform)}</td>
                <td class="log-col-details">${escapeHtml(log.details)}</td>
            </tr>
            <tr class="log-raw-row hidden">
                <td colspan="10"><span class="log-raw-label">Original log line</span>${escapeHtml(log.text)}</td>
            </tr>
        `;
    }).join('');
}

function toggleLogRaw(row) {
    // Leave the row alone when the user is selecting text to copy.
    if (window.getSelection && String(window.getSelection())) return;
    row.nextElementSibling?.classList.toggle('hidden');
}

function filterLogsConsole() {
    renderLogsTable(cachedLogs);
    const scrollEl = document.getElementById('logTableScroll');
    if (scrollEl) scrollEl.scrollTop = 0;
    setLogsPaused(false);
}

function switchLogTab(tabId) {
    activeLogTab = tabId;
    document.querySelectorAll('.log-tab').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`.log-tab[data-tab="${tabId}"]`)?.classList.add('active');
    fetchLogs(true);
}

function switchSeverityFilter(sevId) {
    activeSeverityFilter = sevId;
    document.querySelectorAll('.severity-pill').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`.severity-pill[data-severity="${sevId === 'INFO' ? 'info' : (sevId === 'WARNING' ? 'warning' : (sevId === 'ERROR' ? 'error' : 'all'))}"]`)?.classList.add('active');
    fetchLogs(true);
}

function exportLogs() {
    const filtered = filterLogsBySearch(cachedLogs);

    // One row per event with every field plus the untouched log line as evidence.
    const columns = [
        ['time_utc', l => l.time],
        ['severity', l => l.severity],
        ['category', l => LOG_CATEGORY_LABELS[l.category] || l.category],
        ['event', l => l.event],
        ['user', l => l.user],
        ['certificate_cn', l => l.cert_cn],
        ['source_ip', l => l.ip],
        ['source_port', l => l.port],
        ['virtual_ip', l => l.virtual_ip],
        ['client_platform', l => l.platform],
        ['client_software', l => l.client],
        ['details', l => l.details],
        ['raw_log_line', l => l.text]
    ];
    const csvCell = (value) => {
        let text = String(value ?? '');
        // Keep spreadsheet apps from running a cell as a formula.
        if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
        return `"${text.replace(/"/g, '""')}"`;
    };
    const textContent = [columns.map(c => c[0]).join(',')]
        .concat(filtered.map(l => columns.map(c => csvCell(c[1](l))).join(',')))
        .join('\r\n');
    const blob = new Blob([textContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openvpn-log-export-${new Date().toISOString().slice(0,19).replace(/[:T]/g, '-')}-UTC.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showToast(message) {
    const toast = document.getElementById('toastNotification');
    if (!toast) return;
    
    toast.textContent = message;
    toast.classList.remove('hidden');
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.classList.add('hidden');
        }, 300);
    }, 3000);
}

if (!String.prototype.strip) {
    String.prototype.strip = function() {
        return this.trim();
    };
}
