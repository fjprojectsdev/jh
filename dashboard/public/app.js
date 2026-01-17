const state = {
    token: localStorage.getItem('imavy_token') || null
};

const elements = {
    loginOverlay: document.getElementById('loginOverlay'),
    loginBtn: document.getElementById('loginBtn'),
    password: document.getElementById('password'),
    loginError: document.getElementById('loginError'),
    logoutBtn: document.getElementById('logoutBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    statusPill: document.getElementById('statusPill'),
    toast: document.getElementById('toast'),
    statBanned: document.getElementById('statBanned'),
    statGroups: document.getElementById('statGroups'),
    statAdmins: document.getElementById('statAdmins'),
    statReminders: document.getElementById('statReminders'),
    statLeads: document.getElementById('statLeads'),
    wordsList: document.getElementById('wordsList'),
    groupsList: document.getElementById('groupsList'),
    adminsList: document.getElementById('adminsList'),
    logsList: document.getElementById('logsList'),
    leadsList: document.getElementById('leadsList'),
    newWord: document.getElementById('newWord'),
    newGroup: document.getElementById('newGroup'),
    quickWord: document.getElementById('quickWord'),
    quickGroup: document.getElementById('quickGroup'),
    pageTitle: document.getElementById('pageTitle'),
    pageSubtitle: document.getElementById('pageSubtitle')
};

const sectionMeta = {
    overview: {
        title: 'Visão Geral',
        subtitle: 'Métricas e atalhos rápidos do bot.'
    },
    banned: {
        title: 'Palavras Banidas',
        subtitle: 'Atualize o filtro de termos proibidos.'
    },
    groups: {
        title: 'Grupos Permitidos',
        subtitle: 'Gerencie os grupos habilitados.'
    },
    admins: {
        title: 'Administradores',
        subtitle: 'Lista de usuários autorizados.'
    },
    logs: {
        title: 'Logs',
        subtitle: 'Registros das ações recentes.'
    },
    leads: {
        title: 'Leads',
        subtitle: 'Últimos contatos capturados pelo bot.'
    }
};

function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('show');
    setTimeout(() => elements.toast.classList.remove('show'), 2400);
}

async function api(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json'
    };
    if (state.token) {
        headers.Authorization = `Bearer ${state.token}`;
    }

    const response = await fetch(path, {
        ...options,
        headers
    });

    if (response.status === 401 || response.status === 403) {
        handleLogout();
        throw new Error('Sessão expirada.');
    }

    return response.json();
}

function setStatus(online) {
    if (online) {
        elements.statusPill.textContent = 'Online';
        elements.statusPill.classList.add('online');
    } else {
        elements.statusPill.textContent = 'Offline';
        elements.statusPill.classList.remove('online');
    }
}

async function handleLogin() {
    const password = elements.password.value.trim();
    if (!password) {
        elements.loginError.textContent = 'Informe a senha.';
        return;
    }

    elements.loginError.textContent = '';
    const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });

    if (!response.ok) {
        elements.loginError.textContent = 'Senha incorreta.';
        return;
    }

    const data = await response.json();
    state.token = data.token;
    localStorage.setItem('imavy_token', data.token);
    elements.password.value = '';
    elements.loginOverlay.style.display = 'none';
    await loadDashboard();
    showToast('Login realizado.');
}

function handleLogout() {
    state.token = null;
    localStorage.removeItem('imavy_token');
    elements.loginOverlay.style.display = 'flex';
    setStatus(false);
}

async function loadStats() {
    const stats = await api('/api/stats');
    elements.statBanned.textContent = stats.bannedWords || 0;
    elements.statGroups.textContent = stats.allowedGroups || 0;
    elements.statAdmins.textContent = stats.admins || 0;
    elements.statReminders.textContent = stats.lembretes || 0;
    elements.statLeads.textContent = stats.leads || 0;
    setStatus(true);
}

function renderList(container, items, emptyMessage) {
    if (!items.length) {
        container.innerHTML = `<div class="list-item"><div>${emptyMessage}</div></div>`;
        return;
    }

    container.innerHTML = items.join('');
}

async function loadBannedWords() {
    const words = await api('/api/banned-words');
    const items = words.map((word) => `
        <div class="list-item">
            <div>
                <strong>${word}</strong>
                <p>Filtro ativo</p>
            </div>
            <button class="action-btn" data-word="${encodeURIComponent(word)}">Remover</button>
        </div>
    `);

    renderList(elements.wordsList, items, 'Nenhuma palavra cadastrada.');
}

async function loadGroups() {
    const groups = await api('/api/allowed-groups');
    const items = groups.map((group) => `
        <div class="list-item">
            <div>
                <strong>${group}</strong>
                <p>Grupo autorizado</p>
            </div>
            <button class="action-btn" data-group="${encodeURIComponent(group)}">Remover</button>
        </div>
    `);

    renderList(elements.groupsList, items, 'Nenhum grupo cadastrado.');
}

async function loadAdmins() {
    const admins = await api('/api/admins');
    const items = admins.map((admin) => `
        <div class="list-item">
            <div>
                <strong>${admin}</strong>
                <p>Administrador ativo</p>
            </div>
            <span class="tag">Admin</span>
        </div>
    `);

    renderList(elements.adminsList, items, 'Nenhum admin encontrado.');
}

async function loadLogs() {
    const logs = await api('/api/logs');
    const items = logs.map((log) => `
        <div class="list-item">
            <div>
                <strong>${log.action}</strong>
                <p>${log.timestamp || 'Sem timestamp'}</p>
            </div>
            <span class="tag">Log</span>
        </div>
    `);

    renderList(elements.logsList, items, 'Sem logs recentes.');
}

async function loadLeads() {
    const leads = await api('/api/leads');
    const items = leads.map((lead) => `
        <div class="list-item">
            <div>
                <strong>${lead.name || lead.phone || 'Lead'}</strong>
                <p>${lead.updated_at || lead.created_at || 'Registro recente'}</p>
            </div>
            <span class="tag">Lead</span>
        </div>
    `);

    renderList(elements.leadsList, items, 'Sem leads cadastrados.');
}

async function loadDashboard() {
    await Promise.all([
        loadStats(),
        loadBannedWords(),
        loadGroups(),
        loadAdmins(),
        loadLogs(),
        loadLeads()
    ]);
}

async function addWord(input) {
    const value = input.value.trim();
    if (!value) return;
    await api('/api/banned-words', {
        method: 'POST',
        body: JSON.stringify({ word: value })
    });
    input.value = '';
    await loadBannedWords();
    await loadStats();
    showToast('Palavra adicionada.');
}

async function addGroup(input) {
    const value = input.value.trim();
    if (!value) return;
    await api('/api/allowed-groups', {
        method: 'POST',
        body: JSON.stringify({ name: value })
    });
    input.value = '';
    await loadGroups();
    await loadStats();
    showToast('Grupo adicionado.');
}

function setupMenu() {
    const menuItems = document.querySelectorAll('.menu-item');
    const sections = document.querySelectorAll('.section');

    menuItems.forEach((item) => {
        item.addEventListener('click', () => {
            menuItems.forEach((btn) => btn.classList.remove('active'));
            item.classList.add('active');

            const target = item.dataset.section;
            sections.forEach((section) => {
                section.classList.toggle('active', section.id === target);
            });

            const meta = sectionMeta[target];
            elements.pageTitle.textContent = meta.title;
            elements.pageSubtitle.textContent = meta.subtitle;
        });
    });
}

function setupActions() {
    elements.loginBtn.addEventListener('click', handleLogin);
    elements.password.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') handleLogin();
    });
    elements.logoutBtn.addEventListener('click', () => {
        handleLogout();
        showToast('Sessão encerrada.');
    });
    elements.refreshBtn.addEventListener('click', async () => {
        await loadDashboard();
        showToast('Dados atualizados.');
    });

    document.getElementById('addWordBtn').addEventListener('click', () => addWord(elements.newWord));
    document.getElementById('addGroupBtn').addEventListener('click', () => addGroup(elements.newGroup));
    document.getElementById('quickWordBtn').addEventListener('click', () => addWord(elements.quickWord));
    document.getElementById('quickGroupBtn').addEventListener('click', () => addGroup(elements.quickGroup));

    elements.wordsList.addEventListener('click', async (event) => {
        const target = event.target;
        if (target.matches('button[data-word]')) {
            const word = target.getAttribute('data-word');
            await api(`/api/banned-words/${word}`, { method: 'DELETE' });
            await loadBannedWords();
            await loadStats();
            showToast('Palavra removida.');
        }
    });

    elements.groupsList.addEventListener('click', async (event) => {
        const target = event.target;
        if (target.matches('button[data-group]')) {
            const group = target.getAttribute('data-group');
            await api(`/api/allowed-groups/${group}`, { method: 'DELETE' });
            await loadGroups();
            await loadStats();
            showToast('Grupo removido.');
        }
    });
}

function init() {
    setupMenu();
    setupActions();

    if (state.token) {
        elements.loginOverlay.style.display = 'none';
        loadDashboard().catch(() => handleLogout());
    } else {
        elements.loginOverlay.style.display = 'flex';
    }
}

init();
