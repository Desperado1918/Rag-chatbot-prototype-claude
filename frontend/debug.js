// ============================================================================
// debug.js — Frontend Script for ChromaDB Chunk Inspector
// ============================================================================

const API_BASE = window.location.origin;

// DOM Elements
const chatSelect = document.getElementById("chatSelect");
const chunksContainer = document.getElementById("chunksContainer");

// Fetch API helper
async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...options,
    });
    if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error ${res.status}`);
    }
    return res.json();
}

// Load and populate conversation selector
async function loadConversations() {
    try {
        const data = await api("/api/chats");
        const chats = data.chats || [];

        // Clear existing except first option
        chatSelect.innerHTML = '<option value="">-- Choose a conversation --</option>';

        chats.forEach((chat) => {
            const opt = document.createElement("option");
            opt.value = chat._id;
            opt.textContent = `${chat.title || "Untitled Chat"} (${chat.messageCount || 0} msgs)`;
            chatSelect.appendChild(opt);
        });

        // Pre-select active chat from query params if present
        const urlParams = new URLSearchParams(window.location.search);
        const activeChatId = urlParams.get("chatId");
        if (activeChatId && chats.some(c => c._id === activeChatId)) {
            chatSelect.value = activeChatId;
            loadChunks(activeChatId);
        }
    } catch (err) {
        console.error("Failed to load conversations:", err);
        chunksContainer.innerHTML = `<div class="no-chunks" style="color: var(--red);">Error loading chats: ${err.message}</div>`;
    }
}

// Fetch and render chunks for selected conversation
async function loadChunks(chatId) {
    if (!chatId) {
        chunksContainer.innerHTML = '<div class="no-chunks">Select a conversation above to inspect stored database chunks.</div>';
        return;
    }

    chunksContainer.innerHTML = '<div class="no-chunks">Loading database chunks...</div>';

    try {
        const data = await api(`/api/debug/chunks/${chatId}`);
        const chunks = data.chunks || [];

        if (chunks.length === 0) {
            chunksContainer.innerHTML = '<div class="no-chunks">No database chunks found for this conversation. Start chatting or upload files to ingest vector chunks!</div>';
            return;
        }

        let html = `
            <div style="margin-bottom: 16px; font-weight: 500; font-size: 14px; color: var(--text-secondary);">
                Total chunks stored: <strong>${data.totalChunks}</strong>
            </div>
            <div class="chunk-grid">
        `;

        chunks.forEach((chunk) => {
            const meta = chunk.metadata || {};
            const source = meta.source || "unknown";
            const badgeClass = source === "conversation" ? "conversation" : "document";
            const docName = meta.documentName || "N/A";
            const messageIds = meta.messageIds ? meta.messageIds.split(",") : [];
            const embeddingPreviewStr = chunk.embeddingPreview && chunk.embeddingPreview.length > 0
                ? `[ ${chunk.embeddingPreview.map(v => v.toFixed(5)).join(", ")} ... ]`
                : "N/A";

            html += `
                <div class="chunk-card">
                    <div class="chunk-header">
                        <span class="chunk-id">ID: ${chunk.id}</span>
                        <span class="chunk-badge ${badgeClass}">${source}</span>
                    </div>
                    <div class="chunk-body">${escapeHtml(chunk.text)}</div>
                    
                    <div class="chunk-meta-grid">
                        <div class="meta-item">
                            <span class="meta-label">Document Name</span>
                            <span class="meta-value">${escapeHtml(docName)}</span>
                        </div>
                        <div class="meta-item">
                            <span class="meta-label">Chunk Index</span>
                            <span class="meta-value">${meta.chunkIndex !== undefined ? meta.chunkIndex : "N/A"}</span>
                        </div>
                        <div class="meta-item">
                            <span class="meta-label">Created At</span>
                            <span class="meta-value">${meta.createdAt ? new Date(meta.createdAt).toLocaleString() : "N/A"}</span>
                        </div>
                        <div class="meta-item">
                            <span class="meta-label">Associated Messages</span>
                            <span class="meta-value" style="font-size: 11px;">
                                ${messageIds.length > 0 ? messageIds.map(id => `<div>• ${id}</div>`).join("") : "None"}
                            </span>
                        </div>
                    </div>

                    <div class="vector-preview">
                        <div class="meta-label" style="margin-bottom: 4px;">Embedding Vector Preview (first 5 dimensions)</div>
                        <div>${embeddingPreviewStr}</div>
                    </div>
                </div>
            `;
        });

        html += "</div>";
        chunksContainer.innerHTML = html;
    } catch (err) {
        console.error("Failed to load chunks:", err);
        chunksContainer.innerHTML = `<div class="no-chunks" style="color: var(--red);">Error loading database chunks: ${err.message}</div>`;
    }
}

// Event Listeners
chatSelect.addEventListener("change", (e) => {
    const chatId = e.target.value;
    loadChunks(chatId);
    
    // Update query param
    const url = new URL(window.location);
    if (chatId) {
        url.searchParams.set("chatId", chatId);
    } else {
        url.searchParams.delete("chatId");
    }
    window.history.pushState(null, "", url.toString());
});

// HTML escaping utility
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// Initialize on page load
loadConversations();
