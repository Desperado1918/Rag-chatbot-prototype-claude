// ============================================================================
// script.js — RAG Chatbot Frontend (PageIndex + Qwen 2.5)
// ============================================================================
// Premium chat interface with:
//   - Drag & drop PDF upload
//   - Markdown rendering in bot responses
//   - SSE streaming with token-by-token display
//   - Welcome chips for quick questions
//   - Upload progress indication
// ============================================================================

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const chatForm           = document.getElementById("chatForm");
const messageInput       = document.getElementById("messageInput");
const sendButton         = document.getElementById("sendButton");
const messagesContainer  = document.getElementById("messagesContainer");
const messagesEl         = document.getElementById("messages");
const statusDot          = document.getElementById("statusDot");
const statusText         = document.getElementById("statusText");
const ingestButton       = document.getElementById("ingestButton");
const ingestProgress     = document.getElementById("ingestProgress");
const ingestProgressText = document.getElementById("ingestProgressText");
const welcomeSection     = document.getElementById("welcomeSection");
const welcomeChips       = document.getElementById("welcomeChips");
const uploadZone         = document.getElementById("uploadZone");
const fileInput          = document.getElementById("fileInput");
const uploadProgress     = document.getElementById("uploadProgress");
const uploadProgressFill = document.getElementById("uploadProgressFill");
const uploadProgressText = document.getElementById("uploadProgressText");

const API_BASE = window.location.origin;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let hasMessages = false;

// ---------------------------------------------------------------------------
// Status Helpers
// ---------------------------------------------------------------------------
function setStatus(label, mode = "idle") {
    statusText.textContent = label;
    statusDot.className = "status-dot";

    if (mode === "ready") statusDot.classList.add("ready");
    if (mode === "busy")  statusDot.classList.add("busy");
}

// ---------------------------------------------------------------------------
// Check Document Status on Load
// ---------------------------------------------------------------------------
async function checkDocumentStatus() {
    try {
        const res = await fetch(`${API_BASE}/status`);
        const data = await res.json();

        if (data.ready) {
            setStatus(`${data.source || "Document"} loaded`, "ready");
        } else {
            setStatus("No document loaded", "idle");
        }
    } catch {
        setStatus("Server offline", "idle");
    }
}

// ---------------------------------------------------------------------------
// Markdown Renderer (lightweight, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Convert markdown text to HTML.
 * Supports: bold, italic, inline code, code blocks, headings,
 * unordered/ordered lists, blockquotes, paragraphs, line breaks.
 */
function renderMarkdown(text) {
    if (!text) return "";

    let html = text;

    // Escape HTML entities first (prevent XSS)
    html = html
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre><code class="lang-${lang || 'text'}">${code.trim()}</code></pre>`;
    });

    // Inline code (`...`)
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Headings (### > ## > #)
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold (**text** or __text__)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic (*text* or _text_)
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');

    // Blockquotes (> text)
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists (- item or * item)
    html = html.replace(/^(?:[-*]) (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Ordered lists (1. item)
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> that aren't already in <ul> into <ol>
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
        if (match.includes('<ul>')) return match;
        return `<ol>${match}</ol>`;
    });

    // Paragraphs — split by double newlines
    const blocks = html.split(/\n{2,}/);
    html = blocks.map(block => {
        block = block.trim();
        if (!block) return "";
        // Don't wrap blocks that are already block-level elements
        if (/^<(h[1-6]|pre|ul|ol|blockquote|li|div)/i.test(block)) {
            return block;
        }
        // Replace single newlines with <br> within paragraphs
        return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    }).join("\n");

    return html;
}

// ---------------------------------------------------------------------------
// Message Builders
// ---------------------------------------------------------------------------

function hideWelcome() {
    if (welcomeSection && !hasMessages) {
        welcomeSection.style.display = "none";
        hasMessages = true;
    }
}

/**
 * Create a message row and append to the feed.
 * Returns { el, textEl } for mutation.
 */
function createMessage(role) {
    hideWelcome();

    const el = document.createElement("div");
    el.className = `message ${role}`;

    // Header with role name
    const header = document.createElement("div");
    header.className = "message-header";

    const roleName = document.createElement("span");
    roleName.className = "message-role";
    roleName.textContent = role === "user" ? "You" : "Research Assistant";

    header.appendChild(roleName);

    // Text content
    const textEl = document.createElement("div");
    textEl.className = "message-text";

    el.appendChild(header);
    el.appendChild(textEl);
    messagesEl.appendChild(el);

    scrollToBottom();
    return { el, textEl };
}

function addUserMessage(text) {
    const { textEl } = createMessage("user");
    textEl.textContent = text;
    scrollToBottom();
}

/**
 * Create a bot message row with typing indicator.
 * Returns a controller to promote to real content.
 */
function addBotTypingRow() {
    hideWelcome();

    const el = document.createElement("div");
    el.className = "message bot";

    const header = document.createElement("div");
    header.className = "message-header";

    const roleName = document.createElement("span");
    roleName.className = "message-role";
    roleName.textContent = "Research Assistant";

    header.appendChild(roleName);

    const indicator = document.createElement("div");
    indicator.className = "typing-indicator";
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement("span");
        dot.className = "typing-dot";
        indicator.appendChild(dot);
    }

    el.appendChild(header);
    el.appendChild(indicator);
    messagesEl.appendChild(el);
    scrollToBottom();

    // Track raw markdown text for final rendering
    let rawText = "";

    return {
        promoteToText(initialText = "") {
            indicator.remove();
            const textEl = document.createElement("div");
            textEl.className = "message-text";
            rawText = initialText;
            textEl.innerHTML = renderMarkdown(rawText);
            el.appendChild(textEl);
            scrollToBottom();
            return { el, textEl, appendMarkdown: (token) => {
                rawText += token;
                textEl.innerHTML = renderMarkdown(rawText);
                scrollToBottom();
            }};
        },
        promoteToError(errorText) {
            el.classList.add("error");
            indicator.remove();
            const textEl = document.createElement("div");
            textEl.className = "message-text";
            textEl.textContent = errorText;
            el.appendChild(textEl);
            scrollToBottom();
        }
    };
}

function appendSources(el, sources) {
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

        const loc = document.createElement("span");
        loc.className = "source-loc";
        loc.textContent = src.source || "Document";
        card.appendChild(loc);

        if (src.page) {
            const page = document.createElement("span");
            page.className = "source-page";
            page.textContent = `p.${src.page}`;
            card.appendChild(page);
        }

        block.appendChild(card);
    });

    el.appendChild(block);
    scrollToBottom();
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
}

// ---------------------------------------------------------------------------
// SSE Streaming
// ---------------------------------------------------------------------------

function parseSseBlock(block) {
    const lines = block.split("\n");
    let event = "message";
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:"))  dataLines.push(line.slice(5).trim());
    }

    return { event, data: dataLines.join("\n") };
}

async function streamChat(question, typingRow) {
    const response = await fetch(`${API_BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question })
    });

    if (!response.ok || !response.body) {
        throw new Error(`Server error ${response.status} — check that the backend is running.`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";
    let sources   = [];
    let promoted  = null;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
            if (!block.trim()) continue;

            const parsed = parseSseBlock(block);
            let payload;

            try {
                payload = JSON.parse(parsed.data);
            } catch {
                continue;
            }

            if (parsed.event === "sources") {
                sources = payload.sources || [];
            }

            if (parsed.event === "token") {
                if (!promoted) {
                    promoted = typingRow.promoteToText("");
                }
                promoted.appendMarkdown(payload.token || "");
            }

            if (parsed.event === "error") {
                throw new Error(payload.error || "Something went wrong");
            }

            if (parsed.event === "done") {
                if (!promoted) {
                    promoted = typingRow.promoteToText(
                        "I don't know based on the provided documents."
                    );
                }
                if (promoted.el) appendSources(promoted.el, sources);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Form Controls
// ---------------------------------------------------------------------------
function setFormBusy(busy) {
    messageInput.disabled = busy;
    sendButton.disabled   = busy;
    ingestButton.disabled = busy;
}

// ---------------------------------------------------------------------------
// Chat Submit
// ---------------------------------------------------------------------------
chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const question = messageInput.value.trim();
    if (!question) return;

    addUserMessage(question);
    messageInput.value = "";

    const typingRow = addBotTypingRow();
    setFormBusy(true);
    setStatus("Retrieving & generating…", "busy");

    try {
        await streamChat(question, typingRow);
    } catch (err) {
        typingRow.promoteToError(err.message);
    } finally {
        setFormBusy(false);
        setStatus("Ready", "ready");
        messageInput.focus();
    }
});

// ---------------------------------------------------------------------------
// Welcome Chips — Click to Auto-Ask
// ---------------------------------------------------------------------------
welcomeChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".welcome-chip");
    if (!chip) return;

    const query = chip.dataset.query;
    if (query) {
        messageInput.value = query;
        chatForm.dispatchEvent(new Event("submit"));
    }
});

// ---------------------------------------------------------------------------
// File Upload — Drag & Drop + Click
// ---------------------------------------------------------------------------

// Click to open file picker
uploadZone.addEventListener("click", (e) => {
    if (e.target === fileInput) return;
    fileInput.click();
});

// Keyboard accessibility
uploadZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
    }
});

// File selected via picker
fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
        uploadFile(fileInput.files[0]);
    }
});

// Drag events
uploadZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadZone.classList.add("dragover");
});

uploadZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadZone.classList.remove("dragover");
});

uploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadZone.classList.remove("dragover");

    const files = e.dataTransfer.files;
    if (files.length > 0) {
        const file = files[0];
        if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
            uploadFile(file);
        } else {
            showUploadError("Only PDF files are accepted.");
        }
    }
});

// Prevent page-level drops
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

/**
 * Upload a PDF file to the server.
 */
async function uploadFile(file) {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
    console.log(`[Upload] ${file.name} (${fileSizeMB} MB)`);

    // Show progress
    uploadProgress.classList.add("active");
    uploadProgressFill.style.width = "10%";
    uploadProgressText.textContent = `Uploading ${file.name}...`;
    setFormBusy(true);
    setStatus("Uploading…", "busy");

    try {
        const formData = new FormData();
        formData.append("file", file);

        // Simulate progress stages
        uploadProgressFill.style.width = "30%";

        const response = await fetch(`${API_BASE}/upload`, {
            method: "POST",
            body: formData
        });

        uploadProgressFill.style.width = "70%";
        uploadProgressText.textContent = "Building document index...";

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Upload failed — check server logs.");
        }

        uploadProgressFill.style.width = "100%";
        uploadProgressText.textContent = "Document ready!";

        setStatus(`${data.source || file.name} loaded`, "ready");

        // Show success message in chat
        setTimeout(() => {
            uploadProgress.classList.remove("active");
            uploadProgressFill.style.width = "0%";

            hideWelcome();
            const { textEl } = createMessage("bot");
            textEl.innerHTML = renderMarkdown(
                `**✓ Document "${data.source}" has been indexed and is ready for questions.**\n\nYou can now ask anything about this document. I'll answer strictly based on its content.`
            );
        }, 800);

    } catch (err) {
        uploadProgress.classList.remove("active");
        uploadProgressFill.style.width = "0%";
        showUploadError(err.message);
        setStatus("Upload failed", "idle");
    } finally {
        setFormBusy(false);
        fileInput.value = "";
    }
}

function showUploadError(message) {
    hideWelcome();
    const { el, textEl } = createMessage("bot");
    el.classList.add("error");
    textEl.textContent = `Upload error: ${message}`;
}

// ---------------------------------------------------------------------------
// Ingest Default Document
// ---------------------------------------------------------------------------
ingestButton.addEventListener("click", async () => {
    setFormBusy(true);
    setStatus("Ingesting…", "busy");
    ingestProgress.classList.add("active");
    ingestProgressText.textContent = "Uploading document to PageIndex...";

    try {
        const response = await fetch(`${API_BASE}/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Ingestion failed — check server logs.");
        }

        setStatus(`${data.source || "Document"} loaded`, "ready");

        // Show success message in chat
        hideWelcome();
        const { textEl } = createMessage("bot");
        textEl.innerHTML = renderMarkdown(
            `**✓ Document "${data.source}" has been indexed and is ready for questions.**\n\nYou can now ask anything about this document.`
        );
    } catch (err) {
        const { el, textEl } = createMessage("bot");
        el.classList.add("error");
        textEl.textContent = err.message;
        setStatus("Ingest failed", "idle");
    } finally {
        setFormBusy(false);
        ingestProgress.classList.remove("active");
    }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
checkDocumentStatus();
messageInput.focus();
