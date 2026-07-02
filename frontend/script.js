// ============================================================================
// script.js — RAG Chatbot Frontend (ChatGPT-style)
// ============================================================================

const API_BASE = window.location.origin;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const app                   = document.getElementById("app");
const sidebar               = document.getElementById("sidebar");
const sidebarToggle         = document.getElementById("sidebarToggle");
const sidebarCloseBtn       = document.getElementById("sidebarCloseBtn");
const newChatBtn            = document.getElementById("newChatBtn");
const conversationSearch    = document.getElementById("conversationSearch");
const conversationList      = document.getElementById("conversationList");
const chatTitle             = document.getElementById("chatTitle");
const chatSubtitle          = document.getElementById("chatSubtitle");
const messagesEl            = document.getElementById("messages");
const welcomeScreen         = document.getElementById("welcomeScreen");
const chatForm              = document.getElementById("chatForm");
const messageInput          = document.getElementById("messageInput");
const sendButton            = document.getElementById("sendButton");
const chunkingMethodSelect  = document.getElementById("chunkingMethod");
const statusText            = document.getElementById("status");
const statusDot             = document.getElementById("statusDot");
const uploadBtn             = document.getElementById("uploadBtn");
const fileInput             = document.getElementById("fileInput");
const contextMenu           = document.getElementById("contextMenu");
const renameOverlay         = document.getElementById("renameOverlay");
const renameInput           = document.getElementById("renameInput");
const renameSaveBtn         = document.getElementById("renameSaveBtn");
const renameCancelBtn       = document.getElementById("renameCancelBtn");
const headerChevronBtn       = document.getElementById("headerChevronBtn");
const chatHeader            = document.querySelector(".chat-header");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentConversationId = null;
let conversations = [];
let contextMenuTargetId = null;
let isStreaming = false;

// Pagination state
let currentSearchQuery = "";
let currentPage = 1;
let hasMoreConversations = true;
let isLoadingMore = false;

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        headers: { "Content-Type": "application/json", ...options.headers },
        ...options,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
function setStatus(label, mode = "idle") {
    statusText.textContent = label;
    statusDot.className = "status-dot" + (mode !== "idle" ? ` ${mode}` : "");
}

// ---------------------------------------------------------------------------
// Textarea auto-resize
// ---------------------------------------------------------------------------
messageInput.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + "px";
});

// ---------------------------------------------------------------------------
// Sidebar toggle
// ---------------------------------------------------------------------------
sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    app.classList.toggle("sidebar-collapsed");
});

sidebarCloseBtn.addEventListener("click", () => {
    sidebar.classList.add("collapsed");
    app.classList.add("sidebar-collapsed");
});

// ---------------------------------------------------------------------------
// Conversation List — Fetch & Render
// ---------------------------------------------------------------------------
function showSidebarSkeletons() {
    conversationList.innerHTML = `
        <div class="skeleton-item"></div>
        <div class="skeleton-item"></div>
        <div class="skeleton-item"></div>
    `;
}

async function loadConversations(searchQuery = "", page = 1) {
    if (isLoadingMore) return;
    isLoadingMore = true;

    try {
        currentSearchQuery = searchQuery;
        currentPage = page;
        
        if (page === 1) {
            showSidebarSkeletons();
        }

        const params = new URLSearchParams();
        if (searchQuery) params.append("search", searchQuery);
        params.append("page", page);
        params.append("limit", 20);

        const data = await api(`/api/chats?${params.toString()}`);
        
        if (page === 1) {
            conversations = data.chats || [];
        } else {
            conversations = [...conversations, ...(data.chats || [])];
        }

        hasMoreConversations = data.pagination && data.pagination.page < data.pagination.totalPages;
        
        renderConversationList();
    } catch (err) {
        console.error("Failed to load conversations:", err);
        if (page === 1) {
            conversationList.innerHTML = `<div class="conv-empty">Failed to load conversations</div>`;
        }
    } finally {
        isLoadingMore = false;
    }
}

conversationList.addEventListener("scroll", () => {
    if (hasMoreConversations && !isLoadingMore) {
        // If scrolled near bottom
        if (conversationList.scrollHeight - conversationList.scrollTop <= conversationList.clientHeight + 100) {
            loadConversations(currentSearchQuery, currentPage + 1);
        }
    }
});

function renderConversationList() {
    if (conversations.length === 0) {
        conversationList.innerHTML = `<div class="conv-empty">No conversations yet</div>`;
        return;
    }

    // Separate pinned, favorited and regular
    const pinned = conversations.filter((c) => c.isPinned);
    const favorites = conversations.filter((c) => c.isFavorited && !c.isPinned);
    const regular = conversations.filter((c) => !c.isPinned && !c.isFavorited);

    let html = "";

    if (pinned.length > 0) {
        html += `<div class="conv-section-label">Pinned</div>`;
        html += pinned.map(renderConvItem).join("");
    }

    if (favorites.length > 0) {
        html += `<div class="conv-section-label">Favorites</div>`;
        html += favorites.map(renderConvItem).join("");
    }

    if (regular.length > 0) {
        // Group regular by date group
        const groups = {
            "Today": [],
            "Yesterday": [],
            "Previous 7 Days": [],
            "Older": []
        };
        
        for (const conv of regular) {
            const groupName = getDateGroup(conv.updatedAt || conv.createdAt);
            if (groups[groupName]) {
                groups[groupName].push(conv);
            } else {
                groups["Older"].push(conv);
            }
        }
        
        for (const [groupName, groupConvs] of Object.entries(groups)) {
            if (groupConvs.length > 0) {
                html += `<div class="conv-section-label">${groupName}</div>`;
                html += groupConvs.map(renderConvItem).join("");
            }
        }
    }

    conversationList.innerHTML = html;

    // Attach event listeners
    conversationList.querySelectorAll(".conv-item").forEach((el) => {
        el.addEventListener("click", () => {
            openConversation(el.dataset.id);
        });

        el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e, el.dataset.id);
        });
    });
}

function renderConvItem(conv) {
    const isActive = conv._id === currentConversationId;
    const badges = [];
    if (conv.isPinned) {
        badges.push(`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-muted); opacity: 0.8; margin-left: 4px;"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.47A2 2 0 0 1 15 9.3V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.3a2 2 0 0 1-.78 1.23l-2.78 3.5A2 2 0 0 0 5 15.24V17z"></path></svg>`);
    }
    if (conv.isFavorited) {
        badges.push(`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--amber); opacity: 0.9; margin-left: 4px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`);
    }

    const preview = conv.lastMessagePreview
        ? escapeHtml(conv.lastMessagePreview).slice(0, 60)
        : "No messages yet";

    return `
        <button class="conv-item${isActive ? " active" : ""}" data-id="${conv._id}">
            <div class="conv-item-content">
                <div class="conv-item-title">${escapeHtml(conv.title)}</div>
                <div class="conv-item-preview">${preview}</div>
            </div>
            <div class="conv-item-meta">
                ${badges.map((b) => `<span class="conv-badge">${b}</span>`).join("")}
            </div>
        </button>
    `;
}

// ---------------------------------------------------------------------------
// Conversation Search
// ---------------------------------------------------------------------------
let searchTimeout = null;
conversationSearch.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        loadConversations(conversationSearch.value.trim());
    }, 300);
});

// ---------------------------------------------------------------------------
// Open Conversation
// ---------------------------------------------------------------------------
async function renderConversationDocuments(conversationId) {
    const docsContainer = document.getElementById("headerDocs");
    if (!docsContainer) return;
    
    docsContainer.innerHTML = "";
    
    try {
        const data = await api(`/api/documents/conversations/${conversationId}`);
        const docs = data.documents || [];
        
        if (docs.length > 0) {
            docs.forEach(doc => {
                const badge = document.createElement("span");
                badge.className = `doc-badge ${doc.embeddingStatus}`;
                const statusIcon = doc.embeddingStatus === "completed" ? "✓" : "⏳";
                badge.innerHTML = `📄 ${escapeHtml(doc.originalName)} <small>${statusIcon}</small>`;
                docsContainer.appendChild(badge);
            });
        }
    } catch (err) {
        console.error("Failed to load documents for header:", err);
    }
}

async function openConversation(id) {
    if (isStreaming) return;

    currentConversationId = id;
    setStatus("Loading…", "busy");

    const chatContainer = document.querySelector(".chat");
    if (chatContainer) {
        chatContainer.classList.remove("welcome-active");
    }

    // Update URL query parameter
    const url = new URL(window.location);
    url.searchParams.set("chatId", id);
    window.history.pushState(null, "", url.toString());

    try {
        const data = await api(`/api/chats/${id}`);
        const conv = data.chat;
        const messages = data.messages || [];

        chatTitle.textContent = conv.title;
        chatSubtitle.textContent = `${messages.length} messages`;

        // Show header actions chevron
        if (headerChevronBtn) {
            headerChevronBtn.style.display = "inline-flex";
        }

        // Load and render associated documents in header
        renderConversationDocuments(id);

        // Hide welcome, show messages
        welcomeScreen.classList.add("hidden");

        // Clear existing messages (except welcome)
        messagesEl.querySelectorAll(".message").forEach((el) => el.remove());

        // Render all messages
        for (const msg of messages) {
            if (msg.role === "user") {
                addUserMessage(msg.content, msg.createdAt, msg._id);
            } else if (msg.role === "assistant") {
                addBotMessage(msg.content, msg.sources, msg.createdAt, msg._id);
            }
        }

        scrollToBottom();
        renderConversationList(); // Update active state
    } catch (err) {
        console.error("Failed to open conversation:", err);
    } finally {
        setStatus("Ready");
    }
}

// ---------------------------------------------------------------------------
// New Chat
// ---------------------------------------------------------------------------
newChatBtn.addEventListener("click", () => {
    currentConversationId = null;
    chatTitle.textContent = "New Chat";
    chatSubtitle.textContent = "Start a conversation with your AI research assistant";

    const chatContainer = document.querySelector(".chat");
    if (chatContainer) {
        chatContainer.classList.add("welcome-active");
    }

    // Reset URL query parameter
    const url = new URL(window.location);
    url.searchParams.delete("chatId");
    window.history.pushState(null, "", url.toString());

    // Hide header actions chevron
    if (headerChevronBtn) {
        headerChevronBtn.style.display = "none";
    }

    // Clear active badges container
    const docsContainer = document.getElementById("headerDocs");
    if (docsContainer) docsContainer.innerHTML = "";

    // Show welcome screen
    welcomeScreen.classList.remove("hidden");
    messagesEl.querySelectorAll(".message").forEach((el) => el.remove());

    // Highlight active sidebar conversations appropriately (none active)
    document.querySelectorAll(".conv-item").forEach((el) => el.classList.remove("active"));
});

// ---------------------------------------------------------------------------
// Welcome Card Prompts
// ---------------------------------------------------------------------------
document.querySelectorAll(".welcome-card").forEach((card) => {
    card.addEventListener("click", () => {
        const prompt = card.dataset.prompt;
        if (prompt) {
            messageInput.value = prompt;
            messageInput.dispatchEvent(new Event("input"));
            chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
        }
    });
});

// ---------------------------------------------------------------------------
// Message Builders
// ---------------------------------------------------------------------------
function enterMessageEditMode(rowEl, messageId, originalText) {
    const bodyEl = rowEl.querySelector(".message-body");
    const textEl = rowEl.querySelector(".message-text");
    const timeEl = rowEl.querySelector(".message-time");
    const editBtn = rowEl.querySelector(".edit-msg-btn");
    
    // Hide standard elements
    textEl.style.display = "none";
    timeEl.style.display = "none";
    if (editBtn) editBtn.style.display = "none";
    
    const editContainer = document.createElement("div");
    editContainer.className = "message-edit-container";
    
    const textarea = document.createElement("textarea");
    textarea.className = "edit-mode-textarea";
    textarea.value = originalText;
    
    const actions = document.createElement("div");
    actions.className = "edit-actions";
    actions.innerHTML = `
        <button class="btn btn-primary btn-save">Save &amp; Submit</button>
        <button class="btn btn-ghost btn-cancel">Cancel</button>
    `;
    
    editContainer.appendChild(textarea);
    editContainer.appendChild(actions);
    bodyEl.insertBefore(editContainer, bodyEl.firstChild);
    
    actions.querySelector(".btn-cancel").addEventListener("click", () => {
        editContainer.remove();
        textEl.style.display = "";
        timeEl.style.display = "";
        if (editBtn) editBtn.style.display = "";
    });
    
    actions.querySelector(".btn-save").addEventListener("click", async () => {
        const newContent = textarea.value.trim();
        if (!newContent || newContent === originalText) {
            actions.querySelector(".btn-cancel").click();
            return;
        }
        
        editContainer.remove();
        setStatus("Saving changes...", "busy");
        
        try {
            // 1. PUT edited message
            await api(`/api/messages/${messageId}`, {
                method: "PUT",
                body: JSON.stringify({ content: newContent })
            });
            
            // 2. Find next message (assistant message) to trigger a retry
            const nextRow = rowEl.nextElementSibling;
            if (nextRow && nextRow.classList.contains("bot")) {
                const nextMsgId = nextRow.querySelector(".retry-btn")?.dataset.id;
                if (nextMsgId) {
                    // Force retry of assistant answer using the updated context
                    await retryMessage(nextMsgId);
                } else {
                    await openConversation(currentConversationId);
                }
            } else {
                await openConversation(currentConversationId);
            }
        } catch (err) {
            console.error("Failed to edit user message:", err);
            alert("Error saving message changes.");
            openConversation(currentConversationId);
        }
    });
}

function addUserMessage(text, timestamp, messageId) {
    const row = document.createElement("div");
    row.className = "message user";
    row.setAttribute("role", "article");
    if (messageId) {
        row.dataset.id = messageId;
    }

    const time = timestamp ? formatTime(timestamp) : formatTime(new Date());

    row.innerHTML = `
        <div class="message-avatar user-avatar" aria-hidden="true">You</div>
        <div class="message-body">
            <div class="message-text">${escapeHtml(text)}</div>
            <div class="message-time">${time}</div>
            ${messageId ? `<button class="edit-msg-btn" title="Edit message">✏️ Edit</button>` : ""}
        </div>
    `;

    if (messageId) {
        row.querySelector(".edit-msg-btn")?.addEventListener("click", () => {
            enterMessageEditMode(row, messageId, text);
        });
    }

    messagesEl.appendChild(row);
    scrollToBottom();
    return row;
}

function addBotMessage(text, sources, timestamp, messageId) {
    const row = document.createElement("div");
    row.className = "message bot";
    row.setAttribute("role", "article");

    const time = timestamp ? formatTime(timestamp) : formatTime(new Date());

    // Render markdown with sanitization
    let renderedText;
    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
        renderedText = DOMPurify.sanitize(marked.parse(text));
    } else {
        renderedText = escapeHtml(text);
    }

    row.innerHTML = `
        <div class="message-avatar bot-avatar" aria-hidden="true">AI</div>
        <div class="message-body">
            <div class="message-text">${renderedText}</div>
            <div class="message-time">${time}</div>
            <div class="message-actions">
                <button class="msg-action-btn copy-btn" title="Copy">Copy</button>
                ${messageId ? `<button class="msg-action-btn retry-btn" data-id="${messageId}" title="Retry">Retry</button>` : ""}
            </div>
        </div>
    `;

    // Syntax highlight code blocks
    if (typeof hljs !== "undefined") {
        row.querySelectorAll("pre code").forEach(block => {
            hljs.highlightElement(block);
            const pre = block.parentElement;
            const copyBtn = document.createElement("button");
            copyBtn.className = "code-copy-btn";
            copyBtn.textContent = "Copy";
            copyBtn.addEventListener("click", () => {
                navigator.clipboard.writeText(block.textContent).then(() => {
                    copyBtn.textContent = "Copied!";
                    setTimeout(() => copyBtn.textContent = "Copy", 1500);
                });
            });
            pre.style.position = "relative";
            pre.appendChild(copyBtn);
        });
    }

    // Attach copy handler
    row.querySelector(".copy-btn")?.addEventListener("click", () => {
        navigator.clipboard.writeText(text).then(() => {
            const btn = row.querySelector(".copy-btn");
            btn.textContent = "Copied!";
            setTimeout(() => (btn.textContent = "Copy"), 1500);
        });
    });

    // Attach retry handler
    row.querySelector(".retry-btn")?.addEventListener("click", () => {
        retryMessage(messageId);
    });

    // Append sources if present
    if (sources && sources.length > 0) {
        const body = row.querySelector(".message-body");
        appendSources(body, sources);
    }

    messagesEl.appendChild(row);
    scrollToBottom();
}

function addTypingIndicator() {
    const row = document.createElement("div");
    row.className = "message bot";
    row.id = "typingRow";
    row.setAttribute("role", "article");

    row.innerHTML = `
        <div class="message-avatar bot-avatar" aria-hidden="true">AI</div>
        <div class="message-body">
            <div class="typing-indicator">
                <span class="typing-dot" aria-hidden="true"></span>
                <span class="typing-dot" aria-hidden="true"></span>
                <span class="typing-dot" aria-hidden="true"></span>
            </div>
        </div>
    `;

    messagesEl.appendChild(row);
    scrollToBottom();
    return row;
}

function removeTypingIndicator() {
    document.getElementById("typingRow")?.remove();
}

function appendSources(body, sources) {
    if (!sources || sources.length === 0) return;

    const block = document.createElement("div");
    block.className = "sources-block";

    const heading = document.createElement("div");
    heading.className = "sources-heading";
    heading.textContent = "Sources";
    block.appendChild(heading);

    sources.forEach((src) => {
        const card = document.createElement("div");
        card.className = "source-card";
        card.style.cursor = "pointer";
        card.style.flexDirection = "column";
        card.style.alignItems = "stretch";
        card.style.gap = "8px";

        const docName = src.metadata?.documentName || src.metadata?.source || src.source || "Document";
        const chunkIdx = src.metadata?.chunkIndex !== undefined ? `Chunk ${src.metadata.chunkIndex}` : "";
        const simScore = typeof src.similarity === "number" ? `sim ${(src.similarity * 100).toFixed(0)}%` : `sim ${src.similarity || "N/A"}`;

        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <span class="source-loc" style="font-weight: 500;">📄 ${escapeHtml(docName)} ${chunkIdx ? `· ${chunkIdx}` : ""}</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="source-score">${simScore}</span>
                    <span class="source-toggle-icon" style="transition: transform 0.2s; font-size: 10px; color: var(--text-muted);">▶</span>
                </div>
            </div>
            <div class="source-content" style="display: none; font-size: 12px; line-height: 1.5; color: var(--text-secondary); background: rgba(0,0,0,0.15); padding: 8px; border-radius: 6px; margin-top: 4px; white-space: pre-wrap; border: 1px solid var(--border-subtle);">
                ${escapeHtml(src.text || "No text content available.")}
            </div>
        `;

        card.addEventListener("click", (e) => {
            // Prevent toggling if selecting text
            if (window.getSelection().toString()) return;
            
            const contentEl = card.querySelector(".source-content");
            const toggleIcon = card.querySelector(".source-toggle-icon");
            if (contentEl.style.display === "none") {
                contentEl.style.display = "block";
                toggleIcon.style.transform = "rotate(90deg)";
            } else {
                contentEl.style.display = "none";
                toggleIcon.style.transform = "";
            }
        });

        block.appendChild(card);
    });

    body.appendChild(block);
}

// ---------------------------------------------------------------------------
// SSE Streaming Chat
// ---------------------------------------------------------------------------
let currentAbortController = null;

async function streamChat(question, chunkingMethod, userRow) {
    currentAbortController = new AbortController();
    const stopBtn = document.getElementById("stopButton");
    if (stopBtn) stopBtn.hidden = false;

    const response = await fetch(`${API_BASE}/api/chats/${currentConversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: question, chunkingMethod }),
        signal: currentAbortController.signal,
    });

    if (!response.ok || !response.body) {
        throw new Error(`Server error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sources = [];
    let fullResponse = "";
    let textEl = null;
    let bodyEl = null;
    let messageId = null;
    let createdAt = null;

    removeTypingIndicator();

    const botRow = document.createElement("div");
    botRow.className = "message bot";
    botRow.setAttribute("role", "article");
    botRow.innerHTML = `
        <div class="message-avatar bot-avatar" aria-hidden="true">AI</div>
        <div class="message-body">
            <div class="message-text streaming-cursor"></div>
        </div>
    `;
    messagesEl.appendChild(botRow);
    textEl = botRow.querySelector(".message-text");
    bodyEl = botRow.querySelector(".message-body");

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() || "";

            for (const block of blocks) {
                if (!block.trim()) continue;

                // New format: data: { type: "...", ... }
                let payload;
                try {
                    const dataLine = block.split("\n").find(l => l.startsWith("data:"));
                    if (!dataLine) continue;
                    payload = JSON.parse(dataLine.slice(5).trim());
                } catch {
                    continue;
                }

                if (payload.type === "token") {
                    fullResponse += payload.token || "";
                    // Render markdown live
                    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
                        textEl.innerHTML = DOMPurify.sanitize(marked.parse(fullResponse));
                    } else {
                        textEl.textContent = fullResponse;
                    }
                    scrollToBottom();
                }

                if (payload.type === "sources") {
                    sources = payload.sources || [];
                }

                if (payload.type === "done") {
                    messageId = payload.assistantMessage?._id;
                    createdAt = payload.assistantMessage?.createdAt;
                    const userMsgId = payload.userMessage?._id;
                    const userCreatedAt = payload.userMessage?.createdAt;

                    // Update user row with saved ID
                    if (userRow && userMsgId) {
                        userRow.dataset.id = userMsgId;
                        const uTime = userRow.querySelector(".message-time");
                        if (uTime) uTime.textContent = formatTime(userCreatedAt || new Date());
                    }

                    // Remove streaming cursor
                    textEl.classList.remove("streaming-cursor");

                    // Final markdown render
                    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
                        textEl.innerHTML = DOMPurify.sanitize(marked.parse(fullResponse));
                        // Syntax highlight code blocks
                        if (typeof hljs !== "undefined") {
                            textEl.querySelectorAll("pre code").forEach(block => {
                                hljs.highlightElement(block);
                                // Add copy button to code blocks
                                const pre = block.parentElement;
                                const copyBtn = document.createElement("button");
                                copyBtn.className = "code-copy-btn";
                                copyBtn.textContent = "Copy";
                                copyBtn.addEventListener("click", () => {
                                    navigator.clipboard.writeText(block.textContent).then(() => {
                                        copyBtn.textContent = "Copied!";
                                        setTimeout(() => copyBtn.textContent = "Copy", 1500);
                                    });
                                });
                                pre.style.position = "relative";
                                pre.appendChild(copyBtn);
                            });
                        }
                    }

                    // Timestamp
                    const timeEl = document.createElement("div");
                    timeEl.className = "message-time";
                    timeEl.textContent = formatTime(createdAt || new Date());
                    bodyEl.appendChild(timeEl);

                    // Action buttons
                    const actionsEl = document.createElement("div");
                    actionsEl.className = "message-actions";
                    actionsEl.innerHTML = `
                        <button class="msg-action-btn copy-btn" title="Copy">Copy</button>
                        ${messageId ? `<button class="msg-action-btn retry-btn" data-id="${messageId}" title="Retry">Retry</button>` : ""}
                    `;
                    bodyEl.appendChild(actionsEl);

                    actionsEl.querySelector(".copy-btn")?.addEventListener("click", () => {
                        navigator.clipboard.writeText(fullResponse).then(() => {
                            const btn = actionsEl.querySelector(".copy-btn");
                            btn.textContent = "Copied!";
                            setTimeout(() => (btn.textContent = "Copy"), 1500);
                        });
                    });
                    actionsEl.querySelector(".retry-btn")?.addEventListener("click", () => {
                        retryMessage(messageId);
                    });

                    appendSources(bodyEl, sources);
                    await loadConversations();
                }

                if (payload.type === "error") {
                    throw new Error(payload.error || "Something went wrong");
                }
            }
        }
    } catch (err) {
        if (err.name === "AbortError") {
            textEl.classList.remove("streaming-cursor");
            const notice = document.createElement("div");
            notice.className = "message-time";
            notice.textContent = "⏹ Generation stopped";
            bodyEl.appendChild(notice);
        } else {
            throw err;
        }
    } finally {
        if (stopBtn) stopBtn.hidden = true;
        currentAbortController = null;
    }

    return { fullResponse, sources };
}

// ---------------------------------------------------------------------------
// Retry Message
// ---------------------------------------------------------------------------
async function retryMessage(messageId) {
    if (isStreaming || !messageId) return;

    isStreaming = true;
    setStatus("Retrying…", "busy");
    setFormBusy(true);

    const typingRow = addTypingIndicator();

    try {
        const response = await fetch(`${API_BASE}/api/messages/${messageId}/retry`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chunkingMethod: chunkingMethodSelect.value }),
        });

        if (!response.ok || !response.body) {
            throw new Error(`Retry failed: ${response.status}`);
        }

        // Stream the retried response
        removeTypingIndicator();
        // Reload the conversation to show updated messages
        await openConversation(currentConversationId);
    } catch (err) {
        removeTypingIndicator();
        console.error("Retry failed:", err);
    } finally {
        isStreaming = false;
        setFormBusy(false);
        setStatus("Ready");
    }
}

// ---------------------------------------------------------------------------
// Chat Submit
// ---------------------------------------------------------------------------
chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const question = messageInput.value.trim();
    const chunkingMethod = chunkingMethodSelect.value;

    if (!question || isStreaming) return;

    // Auto-create conversation if none selected
    if (!currentConversationId) {
        try {
            const data = await api("/api/chats", {
                method: "POST",
                body: JSON.stringify({ title: "New Chat" }),
            });
            currentConversationId = data._id;
            const chatContainer = document.querySelector(".chat");
            if (chatContainer) {
                chatContainer.classList.remove("welcome-active");
            }
            if (headerChevronBtn) {
                headerChevronBtn.style.display = "inline-flex";
            }
        } catch (err) {
            console.error("Failed to create conversation:", err);
            return;
        }
    }

    // Hide welcome screen
    welcomeScreen.classList.add("hidden");

    const userRow = addUserMessage(question);
    messageInput.value = "";
    messageInput.style.height = "auto";

    const typingRow = addTypingIndicator();

    isStreaming = true;
    setFormBusy(true);
    setStatus("Thinking…", "busy");

    try {
        await streamChat(question, chunkingMethod, userRow);
    } catch (err) {
        removeTypingIndicator();
        // Show error as bot message
        const errRow = document.createElement("div");
        errRow.className = "message bot error";
        errRow.innerHTML = `
            <div class="message-avatar bot-avatar" aria-hidden="true">AI</div>
            <div class="message-body">
                <div class="message-text">${escapeHtml(err.message)}</div>
            </div>
        `;
        messagesEl.appendChild(errRow);
        scrollToBottom();
    } finally {
        isStreaming = false;
        setFormBusy(false);
        setStatus("Ready");
        messageInput.focus();
    }
});

// Enter to send (Shift+Enter for newline)
messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
    }
});

// ---------------------------------------------------------------------------
// File Upload
// ---------------------------------------------------------------------------
uploadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    setStatus("Uploading…", "busy");
    setFormBusy(true);

    try {
        // Auto-create conversation if none selected
        if (!currentConversationId) {
            const convData = await api("/api/chats", {
                method: "POST",
                body: JSON.stringify({ title: "New Chat" }),
            });
            currentConversationId = convData._id;
            chatTitle.textContent = "New Chat";
            chatSubtitle.textContent = "Start a conversation with your AI research assistant";
            const chatContainer = document.querySelector(".chat");
            if (chatContainer) {
                chatContainer.classList.remove("welcome-active");
            }
            if (headerChevronBtn) {
                headerChevronBtn.style.display = "inline-flex";
            }
        }

        const formData = new FormData();
        formData.append("document", file);
        formData.append("chunkingMethod", chunkingMethodSelect.value);
        formData.append("conversationId", currentConversationId);

        const res = await fetch(`${API_BASE}/api/documents/upload`, {
            method: "POST",
            body: formData,
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || "Upload failed");
        }

        // Show success in chat
        welcomeScreen.classList.add("hidden");
        const successRow = document.createElement("div");
        successRow.className = "message bot";
        successRow.innerHTML = `
            <div class="message-avatar bot-avatar" aria-hidden="true">AI</div>
            <div class="message-body">
                <div class="message-text">✓ Uploaded <strong>${escapeHtml(file.name)}</strong> — ${data.ingestion?.recordsStored || 0} chunks ingested into <code>${escapeHtml(data.ingestion?.collection || "")}</code>.</div>
            </div>
        `;
        messagesEl.appendChild(successRow);
        scrollToBottom();

        // Render updated document badges in header
        await renderConversationDocuments(currentConversationId);
    } catch (err) {
        console.error("Upload failed:", err);
        // Try legacy ingest as fallback
        try {
            const res = await fetch(`${API_BASE}/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chunkingMethod: chunkingMethodSelect.value }),
            });
            const data = await res.json();
            if (res.ok) {
                welcomeScreen.classList.add("hidden");
                const successRow = document.createElement("div");
                successRow.className = "message bot";
                successRow.innerHTML = `
                    <div class="message-avatar bot-avatar" aria-hidden="true">AI</div>
                    <div class="message-body">
                        <div class="message-text">✓ Ingested <strong>${data.recordsStored}</strong> records into <code>${escapeHtml(data.collection)}</code>.</div>
                    </div>
                `;
                messagesEl.appendChild(successRow);
                scrollToBottom();
            }
        } catch (fallbackErr) {
            console.error("Fallback ingest failed:", fallbackErr);
        }
    } finally {
        setFormBusy(false);
        setStatus("Ready");
        fileInput.value = "";
    }
});

// ---------------------------------------------------------------------------
// Context Menu
// ---------------------------------------------------------------------------
function showContextMenu(e, conversationId, alignElement = null) {
    contextMenuTargetId = conversationId;
    const conv = conversations.find((c) => c._id === conversationId);
    if (!conv) return;

    // Update pin and favorite labels
    contextMenu.querySelector(".ctx-pin-label").textContent = conv.isPinned ? "Unpin" : "Pin";
    contextMenu.querySelector(".ctx-favorite-label").textContent = conv.isFavorited ? "Unfavorite" : "Favorite";

    contextMenu.hidden = false;

    const menuWidth = 180;
    const menuHeight = 150;

    let x, y;
    if (alignElement) {
        // Aligned below the chevron button
        const rect = alignElement.getBoundingClientRect();
        x = rect.left;
        y = rect.bottom + 4;
    } else {
        // Position at click coordinates
        x = e.clientX;
        y = e.clientY;
    }

    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;

    contextMenu.style.left = x + "px";
    contextMenu.style.top = y + "px";
}

// Bind active header actions chevron dropdown
if (headerChevronBtn) {
    headerChevronBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentConversationId) {
            showContextMenu(e, currentConversationId, headerChevronBtn);
        }
    });
}

// Handle context menu actions
contextMenu.querySelectorAll(".ctx-item").forEach((item) => {
    item.addEventListener("click", async () => {
        const action = item.dataset.action;
        contextMenu.hidden = true;

        if (!contextMenuTargetId) return;

        try {
            switch (action) {
                case "rename":
                    showRenameDialog(contextMenuTargetId);
                    break;
                case "pin": {
                    const targetConv = conversations.find((c) => c._id === contextMenuTargetId);
                    if (targetConv && !targetConv.isPinned) {
                        const pinnedCount = conversations.filter((c) => c.isPinned).length;
                        if (pinnedCount >= 5) {
                            alert("You can only pin up to 5 chats.");
                            break;
                        }
                    }
                    await api(`/api/chats/${contextMenuTargetId}`, { method: "PATCH", body: JSON.stringify({ isPinned: !targetConv.isPinned }) });
                    await loadConversations();
                    break;
                }
                case "favorite": {
                    const targetConv = conversations.find((c) => c._id === contextMenuTargetId);
                    if (targetConv) {
                        await api(`/api/chats/${contextMenuTargetId}`, { method: "PATCH", body: JSON.stringify({ isFavorited: !targetConv.isFavorited }) });
                        await loadConversations();
                    }
                    break;
                }
                case "export-markdown": {
                    const data = await api(`/api/chats/${contextMenuTargetId}`);
                    if (data && data.chat) {
                        exportChatAsMarkdown(data.chat.title || "Chat Export", data.messages || []);
                    }
                    break;
                }
                case "export-json": {
                    const data = await api(`/api/chats/${contextMenuTargetId}`);
                    if (data && data.chat) {
                        exportChatAsJson(data.chat.title || "Chat Export", data.messages || []);
                    }
                    break;
                }
                case "delete":
                    if (confirm("Delete this conversation? This cannot be undone.")) {
                        await api(`/api/chats/${contextMenuTargetId}`, { method: "DELETE" });
                        if (contextMenuTargetId === currentConversationId) {
                            currentConversationId = null;
                            chatTitle.textContent = "New Chat";
                            if (headerChevronBtn) {
                                headerChevronBtn.style.display = "none";
                            }
                            const chatContainer = document.querySelector(".chat");
                            if (chatContainer) {
                                chatContainer.classList.add("welcome-active");
                            }
                            // Reset URL query parameter
                            const url = new URL(window.location);
                            url.searchParams.delete("chatId");
                            window.history.pushState(null, "", url.toString());

                            messagesEl.querySelectorAll(".message").forEach((el) => el.remove());
                            welcomeScreen.classList.remove("hidden");
                        }
                        await loadConversations();
                    }
                    break;
            }
        } catch (err) {
            console.error(`Action "${action}" failed:`, err);
        }
    });
});

// Close context menu on outside click
document.addEventListener("click", (e) => {
    if (!contextMenu.contains(e.target) && !e.target.closest(".conv-item-more")) {
        contextMenu.hidden = true;
    }
});

// ---------------------------------------------------------------------------
// Rename Dialog
// ---------------------------------------------------------------------------
function showRenameDialog(conversationId) {
    contextMenuTargetId = conversationId;
    const conv = conversations.find((c) => c._id === conversationId);
    renameInput.value = conv?.title || "";
    renameOverlay.hidden = false;
    renameInput.focus();
    renameInput.select();
}

renameSaveBtn.addEventListener("click", async () => {
    const newTitle = renameInput.value.trim();
    if (!newTitle || !contextMenuTargetId) return;

    try {
        await api(`/api/chats/${contextMenuTargetId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: newTitle }),
        });

        if (contextMenuTargetId === currentConversationId) {
            chatTitle.textContent = newTitle;
        }

        await loadConversations();
    } catch (err) {
        console.error("Rename failed:", err);
    }

    renameOverlay.hidden = true;
});

renameCancelBtn.addEventListener("click", () => {
    renameOverlay.hidden = true;
});

renameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") renameSaveBtn.click();
    if (e.key === "Escape") renameCancelBtn.click();
});

// ---------------------------------------------------------------------------
// Form Busy State
// ---------------------------------------------------------------------------
function setFormBusy(busy) {
    messageInput.disabled = busy;
    sendButton.disabled = busy;
    chunkingMethodSelect.disabled = busy;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(dateStr) {
    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);

        if (diffMins < 1) return "Just now";
        if (diffMins < 60) return `${diffMins}m ago`;

        const diffHrs = Math.floor(diffMins / 60);
        if (diffHrs < 24) return `${diffHrs}h ago`;

        return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
        return "";
    }
}

function exportChatAsMarkdown(title, messages) {
    let md = `# ${title}\n\n`;
    messages.forEach((msg) => {
        const role = msg.role === "user" ? "You" : "Assistant";
        md += `### ${role}\n${msg.content}\n\n`;
    });
    downloadBlob(md, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`, "text/markdown");
}

function exportChatAsJson(title, messages) {
    const data = {
        title,
        exportedAt: new Date().toISOString(),
        messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
        })),
    };
    downloadBlob(JSON.stringify(data, null, 2), `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`, "application/json");
}

function downloadBlob(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Stop Button
// ---------------------------------------------------------------------------
const stopButton = document.getElementById("stopButton");
if (stopButton) {
    stopButton.addEventListener("click", () => {
        if (currentAbortController) {
            currentAbortController.abort();
        }
    });
}

// ---------------------------------------------------------------------------
// Theme Toggle
// ---------------------------------------------------------------------------
const themeToggleBtn = document.getElementById("themeToggleBtn");
if (themeToggleBtn) {
    const sunIcon = themeToggleBtn.querySelector(".sun-icon");
    const moonIcon = themeToggleBtn.querySelector(".moon-icon");

    // Load saved theme
    const savedTheme = localStorage.getItem("theme") || "dark";
    if (savedTheme === "light") {
        document.body.classList.add("light-theme");
        if (sunIcon) sunIcon.style.display = "block";
        if (moonIcon) moonIcon.style.display = "none";
    }

    themeToggleBtn.addEventListener("click", () => {
        const isLight = document.body.classList.toggle("light-theme");
        localStorage.setItem("theme", isLight ? "light" : "dark");
        if (isLight) {
            if (sunIcon) sunIcon.style.display = "block";
            if (moonIcon) moonIcon.style.display = "none";
        } else {
            if (sunIcon) sunIcon.style.display = "none";
            if (moonIcon) moonIcon.style.display = "block";
        }
    });
}

// ---------------------------------------------------------------------------
// Keyboard Shortcuts
// ---------------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
    const isMod = e.ctrlKey || e.metaKey;
    if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        conversationSearch.focus();
    } else if (isMod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newChatBtn.click();
    } else if (e.key === "Escape") {
        contextMenu.hidden = true;
        renameOverlay.hidden = true;
    }
});

// ---------------------------------------------------------------------------
// Warning Banner (in-memory DB)
// ---------------------------------------------------------------------------
const warningBanner = document.getElementById("warningBanner");
const warningDismiss = document.getElementById("warningDismiss");
if (warningDismiss) {
    warningDismiss.addEventListener("click", () => {
        if (warningBanner) warningBanner.hidden = true;
    });
}

// ---------------------------------------------------------------------------
// Date Group Helper
// ---------------------------------------------------------------------------
function getDateGroup(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays <= 7) return "Previous 7 Days";
    return "Older";
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(async function init() {
    // Check health for warning banner
    try {
        const health = await api("/api/health");
        if (health.database?.usingMemoryServer && warningBanner) {
            warningBanner.hidden = false;
        }
    } catch {
        // Server may not be ready yet
    }

    await loadConversations();

    const urlParams = new URLSearchParams(window.location.search);
    const chatId = urlParams.get("chatId");
    if (chatId) {
        const hasConv = conversations.some((c) => c._id === chatId);
        if (hasConv) {
            await openConversation(chatId);
        } else {
            const chatContainer = document.querySelector(".chat");
            if (chatContainer) chatContainer.classList.add("welcome-active");
        }
    } else {
        const chatContainer = document.querySelector(".chat");
        if (chatContainer) chatContainer.classList.add("welcome-active");
    }
})();
