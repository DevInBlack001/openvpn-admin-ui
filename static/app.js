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
let alertsInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }
    updateThemeLabel();
    updateUtcClock();
    setInterval(updateUtcClock, 1000);

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

    fetchAlertSummary();
    alertsInterval = setInterval(fetchAlertSummary, 15000);
}

function stopPolling() {
    if (statsInterval) clearInterval(statsInterval);
    if (clientsInterval) clearInterval(clientsInterval);
    if (logsInterval) clearInterval(logsInterval);
    if (alertsInterval) clearInterval(alertsInterval);
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
    if (activeTab) {
        activeTab.classList.add('active');
        const title = document.getElementById('pageTitle');
        if (title) title.textContent = activeTab.dataset.title || '';
    }
    toggleSidebar(false);

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
    updateThemeLabel();
}

// The button names the theme a click switches to.
function updateThemeLabel() {
    const button = document.getElementById('themeToggleBtn');
    if (button) {
        button.textContent = document.body.classList.contains('light-theme') ? 'Dark Mode' : 'Light Mode';
    }
}

// Opens or closes the navigation drawer used on narrow screens.
function toggleSidebar(open) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const show = open === undefined ? !sidebar.classList.contains('open') : open;
    sidebar.classList.toggle('open', show);
    document.getElementById('sidebarBackdrop')?.classList.toggle('visible', show);
}

function updateUtcClock() {
    const clock = document.getElementById('utcClock');
    if (clock) clock.textContent = new Date().toISOString().slice(0, 19).replace('T', ' ');
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
            showVpnStatus(data.vpn_status_age);
        })
        .catch(() => {
            show('cpuUsageStat', null);
            show('ramUsageStat', null);
            showVpnStatus(undefined);
        });
}

// OpenVPN rewrites its status file while it runs, so a fresh file means a live server.
const VPN_STATUS_STALE_SECONDS = 60;

function showVpnStatus(ageSeconds) {
    const dot = document.getElementById('vpnStatusDot');
    const text = document.getElementById('vpnStatusText');
    if (!dot || !text) return;
    dot.classList.remove('online', 'offline');
    if (ageSeconds === undefined || ageSeconds === null) {
        text.textContent = 'VPN state unknown';
    } else if (ageSeconds <= VPN_STATUS_STALE_SECONDS) {
        dot.classList.add('online');
        text.textContent = 'VPN Online';
    } else {
        dot.classList.add('offline');
        text.textContent = 'VPN Offline';
    }
}

// Dashboard alert summary: warnings and errors from the last 24 hours.
const ALERT_PANEL_ROWS = 8;
const ALERT_FETCH_ROWS = 1000;

function fetchAlertSummary() {
    const query = (severity) =>
        fetch(`/api/logs?severity=${severity}&timeframe=24h&limit=${ALERT_FETCH_ROWS}`).then(res => res.json());

    Promise.all([query('ERROR'), query('WARNING')])
        .then(([errors, warnings]) => {
            const count = (rows, test) => rows.filter(test).length;
            const capped = (n, rows) => (rows.length >= ALERT_FETCH_ROWS ? `${n}+` : String(n));

            setAlertStat('failedLogins', capped(count(errors, r => r.event === 'Login failed'), errors), 'is-danger');
            setAlertStat('tlsErrors', capped(count(errors, r => r.category === 'tls'), errors), 'is-danger');
            setAlertStat('probes', capped(count(warnings, r => r.category === 'tls'), warnings), 'is-warning');
            setAlertStat('limitRejects', capped(count(warnings, r => r.event === 'Device limit exceeded'), warnings), 'is-warning');

            const badge = document.getElementById('navAlertCount');
            if (badge) {
                badge.textContent = capped(errors.length, errors);
                badge.classList.toggle('hidden', errors.length === 0);
            }

            const recent = errors.concat(warnings)
                .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
                .slice(0, ALERT_PANEL_ROWS);
            renderAlertPanel(recent);
        })
        .catch(err => console.error("Error fetching alert summary:", err));
}

function setAlertStat(name, text, alarmClass) {
    const value = document.getElementById(`${name}Stat`);
    const card = document.getElementById(`${name}Card`);
    if (value) value.textContent = text;
    if (card) card.classList.toggle(alarmClass, text !== '0');
}

function renderAlertPanel(rows) {
    const tbody = document.getElementById('alertTableBody');
    if (!tbody) return;
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="log-empty">No warnings or errors in the last 24 hours.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(log => `
            <tr class="log-row-${escapeHtml(log.severity.toLowerCase())}">
                <td class="log-col-time">${log.time ? escapeHtml(log.time) : LOG_MUTED}</td>
                ${logSeverityCell(log, false)}
                ${logEventCell(log)}
                ${logIdentityCell(log)}
                ${logNetworkCell(log)}
            </tr>
        `).join('');
}

// Jumps to the Event Log filtered the same way as the alert panel's errors.
function openAlertsInEventLog() {
    const timeframe = document.getElementById('logTimeframeSelector');
    if (timeframe) timeframe.value = '24h';
    activeSeverityFilter = 'ERROR';
    document.querySelectorAll('.severity-pill').forEach(btn => btn.classList.remove('active'));
    document.querySelector('.severity-pill[data-severity="error"]')?.classList.add('active');
    switchPage('logsPage');
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
                <td colspan="8" class="text-center py-4 text-secondary">
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
                            Download
                        </button>
                        <button class="btn btn-danger btn-sm" data-name="${safeName}" onclick="confirmRevokeClient(this.dataset.name)" title="Revoke Certificate">
                            Revoke
                        </button>
                    </div>
                `;
            } else {
                actionButtons = `
                    <div class="actions-cell-wrapper">
                        <button class="btn btn-danger btn-sm" data-name="${safeName}" onclick="confirmDeleteClient(this.dataset.name)" title="Delete Profile">
                            Delete
                        </button>
                    </div>
                `;
            }
        } else {
            if (client.status === 'Valid') {
                actionButtons = `
                    <div class="actions-cell-wrapper">
                        <button class="btn btn-secondary btn-sm" data-name="${safeName}" onclick="downloadClient(this.dataset.name)" title="Download Configuration">
                            Download
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
        
        // One "address:port" line per connected device.
        let realAddress = '-';
        if (client.devices && client.devices.length) {
            realAddress = client.devices.map(d =>
                `<span class="log-ip">${escapeHtml(d.real_address)}</span><span class="log-port">:${escapeHtml(d.port)}</span>` +
                `<div class="log-sub" title="Virtual IP">VPN ${escapeHtml(d.virtual_address)}</div>`
            ).join('');
        }

        const expiryDate = (client.expiry || '-').split(' ')[0];

        const isPasswordRevealed = revealedPasswords.has(client.name);
        const passwordDisplay = isPasswordRevealed ? escapeHtml(client.password || '-') : '••••••••';
        const passwordBg = isPasswordRevealed ? 'rgba(128,128,128,0.2)' : 'rgba(128,128,128,0.1)';
        
        tr.innerHTML = `
            <td class="client-name-cell" title="${escapeHtml(client.username)}">
                ${escapeHtml(client.username || '-')}
                <div class="log-sub" title="Certificate CN">CN ${safeName}</div>
            </td>
            <td title="Expires ${escapeHtml(client.expiry)} UTC">
                ${statusBadge}
                <div class="log-sub">until ${escapeHtml(expiryDate)}</div>
            </td>
            <td>${connectionStatus}</td>
            <td style="text-align: center;">${escapeHtml(limitLabel)}</td>
            <td>${client.password === null
                ? '<span class="text-muted" title="Visible to administrators">Hidden</span>'
                : `<span class="password-cell" data-name="${safeName}" onclick="togglePasswordReveal(this, this.dataset.name)" data-password="${escapeHtml(client.password || '-')}" style="cursor: pointer; font-family: monospace; background: ${passwordBg}; padding: 4px 8px; border-radius: 4px; font-size: 0.8125rem;">${passwordDisplay}</span>`}</td>
            <td class="ip-cell">${realAddress}</td>
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
        tbody.innerHTML = `<tr><td colspan="6" class="log-empty">No matching log records found.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(log => `
            <tr class="log-row log-row-${escapeHtml(log.severity.toLowerCase())}" onclick="toggleLogRaw(this)" title="Click to show the original log line">
                <td class="log-col-time">${log.time ? escapeHtml(log.time) : LOG_MUTED}</td>
                ${logSeverityCell(log, true)}
                ${logEventCell(log)}
                ${logIdentityCell(log)}
                ${logNetworkCell(log)}
                <td class="log-col-client" title="${escapeHtml([log.client, log.platform].filter(Boolean).join(' / '))}">${log.client || log.platform ? escapeHtml(log.client || log.platform) : LOG_MUTED}</td>
            </tr>
            <tr class="log-raw-row hidden">
                <td colspan="6"><span class="log-raw-label">Original log line</span>${escapeHtml(log.text)}</td>
            </tr>
        `).join('');
}

// Cells shared by the event log and the dashboard's alert panel. Related
// fields are stacked so a row shows the whole session without sideways scrolling.
const LOG_MUTED = '<span class="text-muted">-</span>';

function logSeverityCell(log, withCategory) {
    let sevBadge = 'badge-info';
    if (log.severity === 'WARNING') sevBadge = 'badge-warning';
    if (log.severity === 'ERROR') sevBadge = 'badge-danger';
    const category = withCategory
        ? `<div class="log-sub">${escapeHtml(LOG_CATEGORY_LABELS[log.category] || log.category)}</div>`
        : '';
    return `<td><span class="badge ${sevBadge}">${escapeHtml(log.severity)}</span>${category}</td>`;
}

function logEventCell(log) {
    return `
        <td class="log-col-event">
            ${escapeHtml(log.event)}
            <div class="log-event-details">${escapeHtml(log.details)}</div>
        </td>`;
}

function logIdentityCell(log) {
    const user = log.user ? escapeHtml(log.user) : LOG_MUTED;
    const cn = log.cert_cn ? `<div class="log-sub" title="Certificate CN">CN ${escapeHtml(log.cert_cn)}</div>` : '';
    return `<td class="log-col-user" title="${escapeHtml(log.user)}">${user}${cn}</td>`;
}

function logNetworkCell(log) {
    const source = log.ip
        ? `<span class="log-ip">${escapeHtml(log.ip)}</span><span class="log-port">:${escapeHtml(log.port)}</span>`
        : LOG_MUTED;
    const virtual = log.virtual_ip ? `<div class="log-sub" title="Virtual IP">VPN ${escapeHtml(log.virtual_ip)}</div>` : '';
    return `<td class="log-col-mono">${source}${virtual}</td>`;
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
