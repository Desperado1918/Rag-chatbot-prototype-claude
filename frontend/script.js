// ============================================================================
// script.js — RAG Chatbot Frontend
// ============================================================================

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const chatForm          = document.getElementById("chatForm");
const messageInput      = document.getElementById("messageInput");
const sendButton        = document.getElementById("sendButton");
const messages          = document.getElementById("messages");
const statusText        = document.getElementById("status");
const statusDot         = document.getElementById("statusDot");
const chunkingMethodSelect = document.getElementById("chunkingMethod");
const ingestButton      = document.getElementById("ingestButton");
const sidebarToggle     = document.getElementById("sidebarToggle");
const sidebar           = document.getElementById("sidebar");

// ---------------------------------------------------------------------------
// Sidebar toggle
// ---------------------------------------------------------------------------
sidebarToggle.addEventListener("click", () => {
    const isCollapsed = sidebar.classList.toggle("collapsed");
    sidebarToggle.setAttribute("aria-expanded", String(!isCollapsed));
});

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function setStatus(label, mode = "idle") {
    statusText.textContent = label;
    statusDot.className    = "status-dot" + (mode !== "idle" ? ` ${mode}` : "");
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/**
 * Create a full message row (avatar + body) and append it to the feed.
 * Returns { row, textEl } so callers can mutate the text later.
 */
function createMessageRow(type) {
    const row = document.createElement("div");
    row.className = `message ${type}`;
    row.setAttribute("role", "article");

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = `message-avatar ${type === "user" ? "user-avatar" : "bot-avatar"}`;
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = type === "user" ? "You" : "AI";

    // Body wrapper
    const body = document.createElement("div");
    body.className = "message-body";

    // Text bubble
    const textEl = document.createElement("div");
    textEl.className = "message-text";

    body.appendChild(textEl);
    row.appendChild(avatar);
    row.appendChild(body);
    messages.appendChild(row);

    scrollToBottom();
    return { row, body, textEl };
}

/**
 * Append a user message bubble instantly.
 */
function addUserMessage(text) {
    const { textEl } = createMessageRow("user");
    textEl.textContent = text;
    scrollToBottom();
}

/**
 * Create a bot row that shows an animated typing indicator.
 * Returns handles to replace the indicator with real content.
 */
function addBotTypingRow() {
    const row = document.createElement("div");
    row.className = "message bot";
    row.setAttribute("role", "article");

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = "message-avatar bot-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "AI";

    // Body
    const body = document.createElement("div");
    body.className = "message-body";

    // Typing indicator
    const indicator = document.createElement("div");
    indicator.className = "typing-indicator";
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement("span");
        dot.className = "typing-dot";
        dot.setAttribute("aria-hidden", "true");
        indicator.appendChild(dot);
    }

    body.appendChild(indicator);
    row.appendChild(avatar);
    row.appendChild(body);
    messages.appendChild(row);
    scrollToBottom();

    // Returns a controller for this row
    return {
        /**
         * Replace the typing indicator with a real text bubble.
         * Returns the text element so the caller can stream tokens into it.
         */
        promoteToText(initialText = "") {
            indicator.remove();

            const textEl = document.createElement("div");
            textEl.className = "message-text";
            textEl.textContent = initialText;
            body.appendChild(textEl);
            scrollToBottom();
            return { body, textEl };
        },

        /** Replace the indicator with an error bubble */
        promoteToError(errorText) {
            row.className = "message bot error";
            indicator.remove();
            const textEl = document.createElement("div");
            textEl.className = "message-text";
            textEl.textContent = errorText;
            body.appendChild(textEl);
            scrollToBottom();
        }
    };
}

/**
 * Stream tokens into an existing text element.
 */
function appendToken(textEl, token) {
    // Clear placeholder text on first real token
    if (textEl.dataset.placeholder === "true") {
        textEl.textContent = "";
        delete textEl.dataset.placeholder;
    }
    textEl.textContent += token;
    scrollToBottom();
}

/**
 * Append pretty source cards below the answer bubble.
 */
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

        const loc = src.parentNumber
            ? `parent ${src.parentNumber}`
            : `chunk ${src.chunkNumber}`;

        const locEl = document.createElement("span");
        locEl.className = "source-loc";
        locEl.textContent = `${src.source} · ${loc}`;

        const scoreEl = document.createElement("span");
        scoreEl.className = "source-score";
        scoreEl.textContent = `sim ${src.similarity}`;

        card.appendChild(locEl);
        card.appendChild(scoreEl);
        block.appendChild(card);
    });

    body.appendChild(block);
    scrollToBottom();
}

function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
}

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

/**
 * Parse a single SSE block (event: / data: lines) into { event, data }.
 */
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

/**
 * Open an SSE stream for the given question and pipe tokens into `textEl`.
 * Resolves with the sources array when the stream is done.
 */
async function streamChat(question, chunkingMethod, typingRow) {
    const response = await fetch("http://localhost:3000/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, chunkingMethod })
    });

    if (!response.ok || !response.body) {
        throw new Error(`Server error ${response.status} — check that the backend is running.`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";
    let sources   = [];
    let textEl    = null;   // initialised on first token
    let body      = null;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
            if (!block.trim()) continue;

            const parsed  = parseSseBlock(block);
            let   payload;

            try {
                payload = JSON.parse(parsed.data);
            } catch {
                continue;
            }

            if (parsed.event === "sources") {
                sources = payload.sources || [];
            }

            if (parsed.event === "token") {
                // Promote typing indicator → text bubble on first token
                if (!textEl) {
                    ({ body, textEl } = typingRow.promoteToText(""));
                }
                appendToken(textEl, payload.token || "");
            }

            if (parsed.event === "error") {
                throw new Error(payload.error || "Something went wrong");
            }

            if (parsed.event === "done") {
                // If no tokens were emitted (empty context / refusal), promote now
                if (!textEl) {
                    ({ body, textEl } = typingRow.promoteToText("I don't know based on the provided documents."));
                }
                appendSources(body, sources);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Disable / enable form controls
// ---------------------------------------------------------------------------
function setFormBusy(busy) {
    messageInput.disabled          = busy;
    sendButton.disabled            = busy;
    chunkingMethodSelect.disabled  = busy;
    ingestButton.disabled          = busy;
}

// ---------------------------------------------------------------------------
// Chat submit
// ---------------------------------------------------------------------------
chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const question      = messageInput.value.trim();
    const chunkingMethod = chunkingMethodSelect.value;

    if (!question) return;

    addUserMessage(question);
    messageInput.value = "";

    const typingRow = addBotTypingRow();
    setFormBusy(true);
    setStatus("Thinking…", "busy");

    try {
        await streamChat(question, chunkingMethod, typingRow);
    } catch (err) {
        typingRow.promoteToError(err.message);
    } finally {
        setFormBusy(false);
        setStatus("Ready", "idle");
        messageInput.focus();
    }
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------
ingestButton.addEventListener("click", async () => {
    const chunkingMethod = chunkingMethodSelect.value;

    setFormBusy(true);
    setStatus("Ingesting…", "busy");

    try {
        const response = await fetch("http://localhost:3000/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chunkingMethod })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Ingestion failed — check server logs.");
        }

        // Show a success bot message
        const { textEl } = createMessageRow("bot");
        textEl.innerHTML = `✓ Ingested <strong>${data.recordsStored}</strong> records into <code>${data.collection}</code>.`;
    } catch (err) {
        const { row, textEl } = createMessageRow("bot");
        row.className = "message bot error";
        textEl.textContent = err.message;
    } finally {
        setFormBusy(false);
        setStatus("Ready", "idle");
    }
});
