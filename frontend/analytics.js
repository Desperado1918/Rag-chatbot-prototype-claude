// ============================================================================
// analytics.js — Dashboard Client Logic
// ============================================================================

const API_BASE = window.location.origin;

async function loadAnalytics() {
    try {
        const res = await fetch(`${API_BASE}/api/analytics`);
        if (!res.ok) throw new Error("Failed to load analytics");
        const data = await res.json();

        renderStats(data.overview);
        renderChart(data.dailyUsage);
    } catch (err) {
        console.error(err);
        document.getElementById("statGrid").innerHTML = `<div class="stat-card" style="color: var(--red);">Error loading analytics</div>`;
    }
}

function renderStats(overview) {
    const grid = document.getElementById("statGrid");
    grid.innerHTML = `
        <div class="stat-card">
            <div class="stat-label">Conversations</div>
            <div class="stat-value">${overview.totalConversations}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Messages Sent</div>
            <div class="stat-value">${overview.totalMessages}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Documents Indexed</div>
            <div class="stat-value">${overview.totalDocuments}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Avg Retrieval</div>
            <div class="stat-value">${overview.avgRetrievalLatencyMs}<em>ms</em></div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Avg Generation</div>
            <div class="stat-value">${overview.avgGenerationLatencyMs}<em>ms</em></div>
        </div>
    `;
}

function renderChart(dailyUsage) {
    const ctx = document.getElementById('usageChart').getContext('2d');
    
    // Sort dates
    const dates = Object.keys(dailyUsage).sort();
    // If empty, mock some data for preview
    if (dates.length === 0) {
        const today = new Date().toISOString().split("T")[0];
        dates.push(today);
        dailyUsage[today] = 0;
    }

    const data = dates.map(d => dailyUsage[d]);

    // Apply Chart.js defaults for dark theme
    Chart.defaults.color = '#8892aa';
    Chart.defaults.font.family = "'Inter', sans-serif";

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates,
            datasets: [{
                label: 'Messages Sent',
                data: data,
                borderColor: '#7c6fe8',
                backgroundColor: 'rgba(124, 111, 232, 0.1)',
                borderWidth: 2,
                pointBackgroundColor: '#1a1e2b',
                pointBorderColor: '#7c6fe8',
                pointBorderWidth: 2,
                pointRadius: 4,
                fill: true,
                tension: 0.4 // smooth curve
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1a1e2b',
                    titleColor: '#edf0f7',
                    bodyColor: '#8892aa',
                    borderColor: 'rgba(255,255,255,0.12)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.05)' }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    beginAtZero: true,
                    ticks: { precision: 0 }
                }
            }
        }
    });
}

// Init
loadAnalytics();
