const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const messages = document.getElementById("messages");
const statusText = document.getElementById("status");
const chunkingMethodSelect = document.getElementById("chunkingMethod");
const ingestButton = document.getElementById("ingestButton");

function addMessage(text, type) {
    const message = document.createElement("div");
    message.className = `message ${type}`;
    message.textContent = text;
    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
    return message;
}

function updateMessage(message, text, type) {
    message.className = `message ${type}`;
    message.textContent = text;
    messages.scrollTop = messages.scrollHeight;
}

function appendMessage(message, token) {
    if (message.textContent === "Thinking...") {
        message.textContent = "";
    }

    message.textContent += token;
    messages.scrollTop = messages.scrollHeight;
}

function appendSources(message, sources) {
    if (!sources.length) {
        return;
    }

    const sourceList = sources
        .map((source) => {
            const location = source.parentNumber
                ? `parent ${source.parentNumber}`
                : `chunk ${source.chunkNumber}`;

            return `${source.source} (${location}, score ${source.similarity})`;
        })
        .join("\n");

    message.textContent = `${message.textContent.trim()}\n\nSources:\n${sourceList}`;
}

function parseSseBlock(block) {
    const lines = block.split("\n");
    let event = "message";
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith("event:")) {
            event = line.slice(6).trim();
        }

        if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
        }
    }

    return {
        event,
        data: dataLines.join("\n")
    };
}

async function streamChat(message, chunkingMethod, botMessage) {
    const response = await fetch("http://localhost:3000/chat/stream", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            message,
            chunkingMethod
        })
    });

    if (!response.ok || !response.body) {
        throw new Error("Streaming request failed");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sources = [];

    while (true) {
        const { value, done } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
            if (!block.trim()) {
                continue;
            }

            const parsed = parseSseBlock(block);
            const payload = JSON.parse(parsed.data);

            if (parsed.event === "sources") {
                sources = payload.sources || [];
            }

            if (parsed.event === "token") {
                appendMessage(botMessage, payload.token || "");
            }

            if (parsed.event === "error") {
                throw new Error(payload.error || "Something went wrong");
            }

            if (parsed.event === "done") {
                appendSources(botMessage, sources);
            }
        }
    }
}

chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const userMessage = messageInput.value.trim();
    const chunkingMethod = chunkingMethodSelect.value;

    if (!userMessage) {
        return;
    }

    addMessage(userMessage, "user");
    const botMessage = addMessage("Thinking...", "bot pending");
    messageInput.value = "";
    messageInput.disabled = true;
    chunkingMethodSelect.disabled = true;
    chatForm.querySelector("button").disabled = true;
    statusText.textContent = "Thinking";

    try {
        await streamChat(userMessage, chunkingMethod, botMessage);
        botMessage.className = "message bot";
    } catch (error) {
        updateMessage(botMessage, error.message, "bot error");
    } finally {
        messageInput.disabled = false;
        chunkingMethodSelect.disabled = false;
        chatForm.querySelector("button").disabled = false;
        statusText.textContent = "Ready";
        messageInput.focus();
    }
});

ingestButton.addEventListener("click", async () => {
    const chunkingMethod = chunkingMethodSelect.value;

    ingestButton.disabled = true;
    chunkingMethodSelect.disabled = true;
    statusText.textContent = "Ingesting";

    try {
        const response = await fetch("http://localhost:3000/ingest", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                chunkingMethod
            })
        });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Ingestion failed");
        }

        addMessage(
            `Ingested ${data.recordsStored} records into ${data.collection}.`,
            "bot"
        );
    } catch (error) {
        addMessage(error.message, "bot error");
    } finally {
        ingestButton.disabled = false;
        chunkingMethodSelect.disabled = false;
        statusText.textContent = "Ready";
    }
});
