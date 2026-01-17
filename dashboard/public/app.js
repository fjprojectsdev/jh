let token = localStorage.getItem('token');
let socket = null;
let violationsChart = null;
let activityChart = null;

document.addEventListener('DOMContentLoaded', () => {
    if (token) {
        document.getElementById('loginBox').classList.add('hidden');
        document.getElementById('dashboard').classList.remove('hidden');
        initializeDashboard();
    } else {
        // Render login form
        document.getElementById('loginBox').innerHTML = `
            <div class="login-box">
                <h1>iMavyBot Dashboard</h1>
                <input type="password" id="password" placeholder="Digite a senha">
                <button onclick="login()">Entrar</button>
            </div>
        `;
    }
});

async function login() {
    const password = document.getElementById('password').value;
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });

    if (res.ok) {
        const data = await res.json();
        token = data.token;
        localStorage.setItem('token', token);
        window.location.reload();
    } else {
        alert('Senha incorreta!');
    }
}

function logout() {
    localStorage.removeItem('token');
    if (socket) socket.disconnect();
    window.location.reload();
}

function initializeDashboard() {
    setupNavigation();
    loadDashboardData();
    connectWebSocket();
    setInterval(loadDashboardData, 30000); // Auto-refresh
}

function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    const pages = document.querySelectorAll('.page-content');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();

            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            pages.forEach(p => p.classList.add('hidden'));
            document.getElementById(link.dataset.target).classList.remove('hidden');
        });
    });
}

async function loadDashboardData() {
    const headers = { 'Authorization': `Bearer ${token}` };
    try {
        const [stats, logs, bannedWords, allowedGroups, violations, admins, recentActivity] = await Promise.all([
            fetch('/api/stats', { headers }).then(r => r.json()),
            fetch('/api/logs', { headers }).then(r => r.json()),
            fetch('/api/banned-words', { headers }).then(r => r.json()),
            fetch('/api/allowed-groups', { headers }).then(r => r.json()),
            fetch('/api/violations', { headers }).then(r => r.json()),
            fetch('/api/admins', { headers }).then(r => r.json()),
            fetch('/api/recent-activity', { headers }).then(r => r.json())
        ]);

        renderStats(stats);
        renderCharts(violations, recentActivity);
        renderManagement(bannedWords, allowedGroups, admins);
        renderLogs(logs);
        renderRecentActivity(recentActivity);

    } catch (error) {
        console.error("Erro ao carregar dados:", error);
    }
}

function renderStats(stats) {
    const statsGrid = document.querySelector('#main-dashboard .stats-grid');
    statsGrid.innerHTML = `
        <div class="stat-card"><h3>Palavras Banidas</h3><div class="stat-number">${stats.bannedWords}</div></div>
        <div class="stat-card"><h3>Grupos Permitidos</h3><div class="stat-number">${stats.allowedGroups}</div></div>
        <div class="stat-card"><h3>Admins</h3><div class="stat-number">${stats.admins}</div></div>
        <div class="stat-card"><h3>Lembretes</h3><div class="stat-number">${stats.lembretes}</div></div>
    `;
}

function renderCharts(violations, recentActivity) {
    const violationData = {
        labels: violations.map(v => v.type),
        datasets: [{
            label: 'Violações',
            data: violations.map(v => v.count),
            backgroundColor: ['#ef4444', '#f59e0b', '#667eea'],
        }]
    };

    if (violationsChart) violationsChart.destroy();
    violationsChart = new Chart(document.getElementById('violationsChart'), {
        type: 'bar',
        data: violationData,
        options: { responsive: true }
    });

    const activityCounts = recentActivity.reduce((acc, a) => {
        const actionType = a.action.split(':')[0];
        acc[actionType] = (acc[actionType] || 0) + 1;
        return acc;
    }, {});

    const activityData = {
        labels: Object.keys(activityCounts),
        datasets: [{
            label: 'Atividade Recente',
            data: Object.values(activityCounts),
            backgroundColor: ['#ef4444', '#f59e0b', '#667eea', '#10b981', '#3b82f6'],
        }]
    };

    if (activityChart) activityChart.destroy();
    activityChart = new Chart(document.getElementById('activityChart'), {
        type: 'bar',
        data: activityData,
        options: { responsive: true }
    });
}

function renderRecentActivity(recentActivity) {
    document.getElementById('recentActivityList').innerHTML = recentActivity.map(a => `
        <div class="list-item">
            <span>${a.action}</span>
            <span>${new Date(a.timestamp).toLocaleString('pt-BR')}</span>
        </div>
    `).join('');
}

function renderManagement(bannedWords, allowedGroups, admins) {
    document.getElementById('management').innerHTML = `
        <div class="section">
            <h2>Palavras Banidas</h2>
            <div class="input-group">
                <input type="text" id="newWord" placeholder="Nova palavra">
                <button onclick="addWord()">Adicionar</button>
            </div>
            <div id="wordsList">${bannedWords.map(w => `<div class="list-item"><span>${w}</span><button onclick="removeWord('${w}')">Remover</button></div>`).join('')}</div>
        </div>
        <div class="section">
            <h2>Grupos Permitidos</h2>
            <div class="input-group">
                <input type="text" id="newGroup" placeholder="Novo grupo">
                <button onclick="addGroup()">Adicionar</button>
            </div>
            <div id="groupsList">${allowedGroups.map(g => `<div class="list-item"><span>${g}</span><button onclick="removeGroup('${encodeURIComponent(g)}')">Remover</button></div>`).join('')}</div>
        </div>
        <div class="section">
            <h2>Administradores</h2>
            <div id="adminsList">${admins.map(a => `<div class="list-item"><span>${a}</span></div>`).join('')}</div>
        </div>
    `;
}

function renderLogs(logs) {
    document.getElementById('logs').innerHTML = `
        <div class="section">
            <h2>Logs Recentes</h2>
            <div class="logs-container">${logs.map(l => `<div class="log-item"><strong>${new Date(l.timestamp).toLocaleString('pt-BR')}</strong>: ${l.action}</div>`).join('')}</div>
        </div>
    `;
}

function connectWebSocket() {
    socket = io();
    socket.on('connect', () => console.log('WebSocket Conectado'));
    socket.on('update', () => loadDashboardData());
}

// Management functions
async function addWord() {
    const word = document.getElementById('newWord').value;
    if (!word) return;
    await fetch('/api/banned-words', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ word })
    });
    loadDashboardData();
}

async function removeWord(word) {
    await fetch(`/api/banned-words/${word}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    loadDashboardData();
}

async function addGroup() {
    const name = document.getElementById('newGroup').value;
    if (!name) return;
    await fetch('/api/allowed-groups', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    loadDashboardData();
}

async function removeGroup(name) {
    await fetch(`/api/allowed-groups/${name}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    loadDashboardData();
}
